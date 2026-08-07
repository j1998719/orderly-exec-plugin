/**
 * The browser half of request authentication.
 *
 * Each trader's browser holds an ECDSA P-256 keypair. Its public half is bound
 * to their account during onboarding — at the moment Orderly confirms the wallet
 * signed `AddOrderlyKey` — and every later request is signed with the private
 * half. Nothing secret crosses the network after that: a captured request yields
 * a signature over that one call at that one instant, not a credential someone
 * can reuse.
 *
 * This replaced a bearer token, which was the same secret sent again and again
 * and therefore worth stealing once.
 *
 * P-256 rather than the ed25519 the Orderly key uses, because `crypto.subtle`
 * supports it everywhere with no JavaScript dependency — this runs inside third-
 * party DEX pages, where an extra crypto library is a cost the host pays.
 *
 * The private key is stored as a `CryptoKey` in IndexedDB, generated
 * non-extractable: script on the page can ask it to sign, but cannot read it
 * out and use it elsewhere. That does not stop an XSS from signing while the
 * page is open — nothing in a browser does — but it does stop the key itself
 * from being carried away. Losing it (cleared site data, another browser) just
 * means onboarding again.
 */

// Keeps its original name through the rename to twap-plugin, deliberately.
// This database holds the non-extractable signing key; renaming it orphans the
// key every existing browser holds and forces everyone to onboard again. That
// costs more than a tidy string — `remove_orderly_key` is a verified no-op on
// Orderly, so each re-onboard leaves the previous delegated key usable until it
// expires 30 days later.
const DB_NAME = "blockfill";
const STORE = "keys";
const KEY_ID = "request-signing-key";

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

export interface RequestKey {
  /** Base64 SEC1 public point — what the server stores and verifies against. */
  publicKey: string;
  /** Non-extractable; only `crypto.subtle` can use it. */
  privateKey: CryptoKey;
}

function crypt(): SubtleCrypto {
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) {
    // Non-secure origins have no crypto.subtle, and the message otherwise ends
    // up as "cannot read properties of undefined".
    throw new Error("Web Crypto unavailable — TWAP needs an https:// page");
  }
  return subtle;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("indexedDB unavailable"));
  });
}

async function idbGet(id: string): Promise<any> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(id: string, value: any): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function toBase64(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

/**
 * One keypair per account **and cluster**: two traders in one browser must not
 * share a key, and neither may one trader's testnet and mainnet delegations.
 *
 * The chain is in here for a reason that is not obvious. An Orderly account id
 * is `keccak256(wallet, broker)` — no chain in it — so the same wallet has the
 * *same* id on testnet and mainnet, and a request carries only that id. If both
 * clusters had registered the same public key, a signature would prove who the
 * caller is while saying nothing about where they meant to trade, and the
 * server would be left guessing between two live delegations. Nor can the
 * request simply say: a header is not covered by the signature, so a captured
 * request could be replayed with it flipped and a testnet order worked on
 * mainnet with real money. A distinct key per cluster makes the signature
 * itself carry the answer — the server tries each delegation and exactly one
 * verifies.
 */
function keyId(brokerId: string, address: string, chainId: number): string {
  return `${KEY_ID}:${brokerId}:${address.toLowerCase()}:${chainId}`;
}

/** The id used before keys were per-cluster; read once, to migrate it. */
function legacyKeyId(brokerId: string, address: string): string {
  return `${KEY_ID}:${brokerId}:${address.toLowerCase()}`;
}

/**
 * The keypair for this account on this chain, generating and storing one the
 * first time.
 *
 * `extractable: false` on the private half is the point of using WebCrypto here
 * at all — a key kept as a string in localStorage could simply be read out and
 * replayed from anywhere.
 *
 * A key stored under the old, chain-less id is adopted for whichever cluster
 * asks first and then **deleted**, so the trader who already onboarded keeps
 * their delegation instead of being sent back to their wallet. Deleting it is
 * the point: left in place, the other cluster would adopt the same key next
 * time and re-create the ambiguity this split exists to remove.
 */
export async function getOrCreateKey(
  brokerId: string,
  address: string,
  chainId: number,
): Promise<RequestKey> {
  const id = keyId(brokerId, address, chainId);
  const stored = await idbGet(id).catch(() => undefined);
  if (stored?.privateKey && stored?.publicKey) return stored as RequestKey;

  const legacyId = legacyKeyId(brokerId, address);
  const legacy = await idbGet(legacyId).catch(() => undefined);
  if (legacy?.privateKey && legacy?.publicKey) {
    await idbPut(id, legacy);
    await idbPut(legacyId, undefined).catch(() => undefined);
    return legacy as RequestKey;
  }

  const pair = (await crypt().generateKey(ALGORITHM, false, ["sign", "verify"])) as CryptoKeyPair;
  // "raw" is the 65-byte uncompressed SEC1 point the server parses. SPKI would
  // also be exportable here and would be rejected there.
  const publicKey = toBase64(await crypt().exportKey("raw", pair.publicKey));
  const key: RequestKey = { publicKey, privateKey: pair.privateKey };
  await idbPut(id, key);
  return key;
}

/** Forget this account's key on this chain, so the next call onboards afresh. */
export async function dropKey(
  brokerId: string,
  address: string,
  chainId: number,
): Promise<void> {
  await idbPut(keyId(brokerId, address, chainId), undefined).catch(() => undefined);
}

/** Indexed so these drop straight into a `HeadersInit`. */
export interface SignedHeaders extends Record<string, string> {
  "X-Account-Id": string;
  "X-Timestamp": string;
  "X-Signature": string;
}

/**
 * Headers proving this request came from the holder of the account's key.
 *
 * The signed bytes are `timestamp + METHOD + path?query + body`, byte for byte
 * what `services::onboarding::signing_payload` rebuilds — any disagreement
 * rejects every request, so treat the two as one definition in two places.
 *
 * `pathAndQuery` must be exactly what goes on the wire: the server sees the
 * request line, so a signature over a differently-encoded or reordered query
 * string will not verify.
 */
export async function signRequest(
  key: RequestKey,
  accountId: string,
  method: string,
  pathAndQuery: string,
  body = "",
): Promise<SignedHeaders> {
  const timestamp = Date.now();
  const payload = new TextEncoder().encode(`${timestamp}${method}${pathAndQuery}${body}`);
  // Raw r‖s, not DER — `crypto.subtle` produces the former and the server
  // parses it as such.
  const signature = await crypt().sign(SIGN_PARAMS, key.privateKey, payload);
  return {
    "X-Account-Id": accountId,
    "X-Timestamp": String(timestamp),
    "X-Signature": toBase64(signature),
  };
}
