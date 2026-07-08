export interface AccessTokenPayload {
  accessToken: string;
  url: string;
}

const tokenPrefix = "ars1";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const stringToBase64Url = (value: string): string => bytesToBase64Url(textEncoder.encode(value));

const base64UrlToBytes = (value: string): Uint8Array | null => {
  if (!base64UrlPattern.test(value) || value.length % 4 === 1) {
    return null;
  }

  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
};

const base64UrlToString = (value: string): string | null => {
  const bytes = base64UrlToBytes(value);

  if (!bytes) {
    return null;
  }

  try {
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
};

const importHmacKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", textEncoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);

const sign = async (secret: string, data: string): Promise<Uint8Array> => {
  const signature = await crypto.subtle.sign("HMAC", await importHmacKey(secret), textEncoder.encode(data));

  return new Uint8Array(signature);
};

const bytesToHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
};

const isAccessTokenPayload = (value: unknown): value is AccessTokenPayload =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Partial<AccessTokenPayload>).url === "string" &&
  typeof (value as Partial<AccessTokenPayload>).accessToken === "string" &&
  (value as Partial<AccessTokenPayload>).url!.trim().length > 0 &&
  (value as Partial<AccessTokenPayload>).accessToken!.trim().length > 0;

export const createAccessTokenSecret = (): string => {
  const bytes = new Uint8Array(32);

  crypto.getRandomValues(bytes);

  return bytesToBase64Url(bytes);
};

export const encodeAccessToken = async (payload: AccessTokenPayload, secret: string): Promise<string> => {
  const encodedPayload = stringToBase64Url(JSON.stringify(payload));
  const signedData = `${tokenPrefix}.${encodedPayload}`;
  const encodedSignature = bytesToBase64Url(await sign(secret, signedData));

  return `${signedData}.${encodedSignature}`;
};

export const decodeAccessToken = async (token: string, secret: string): Promise<AccessTokenPayload | null> => {
  const [prefix, encodedPayload, encodedSignature, ...extra] = token.split(".");

  if (prefix !== tokenPrefix || !encodedPayload || !encodedSignature || extra.length > 0) {
    return null;
  }

  const signature = base64UrlToBytes(encodedSignature);

  if (!signature) {
    return null;
  }

  const signedData = `${prefix}.${encodedPayload}`;
  const expectedSignature = await sign(secret, signedData);

  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  const decodedPayload = base64UrlToString(encodedPayload);

  if (!decodedPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(decodedPayload) as unknown;

    return isAccessTokenPayload(payload) ? payload : null;
  } catch {
    return null;
  }
};

export const hashAccessToken = async (accessToken: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(accessToken));

  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
};
