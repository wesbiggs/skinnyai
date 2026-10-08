import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// The encrypted objects a synced chat is made of (see sync.js). Everything is
// AES-256-GCM under keys derived from the vault key and the chat's id, so a
// chat's files mean nothing without the vault key, and a file moved to
// another chat or renamed fails to open (its name and chat id are part of
// what GCM authenticates).
//
//   commit file   "SKC1" | nonce (12) | AES-GCM(deflate(JSON payload)) | tag (16)
//   blob file     "SKB1" | nonce (12) | AES-GCM(bytes) | tag (16)
//
// A blob's file name is HMAC(name key, SHA-256 of its bytes): the same
// attachment is stored once per chat, but the store can't tell which known
// file a blob is.

const COMMIT_MAGIC = Buffer.from('SKC1');
const BLOB_MAGIC = Buffer.from('SKB1');
const NONCE = 12;
const TAG = 16;

const derive = (secret, info, salt = '') => Buffer.from(hkdfSync('sha256', secret, Buffer.from(salt), Buffer.from(info), 32));

// The keys one chat uses, from the vault key.
export function chatKeys(vaultKey, chatId) {
  const chat = derive(vaultKey, 'skinnyai chat key v1', chatId);
  return { commit: derive(chat, 'commits'), blob: derive(chat, 'blobs'), name: derive(chat, 'blob names') };
}

function seal(magic, key, plaintext, aad) {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([magic, nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(magic, key, data, aad) {
  if (data.length < magic.length + NONCE + TAG || !data.subarray(0, magic.length).equals(magic)) throw new Error('not a skinnyai sync file');
  const nonce = data.subarray(magic.length, magic.length + NONCE);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(data.subarray(data.length - TAG));
  try {
    return Buffer.concat([decipher.update(data.subarray(magic.length + NONCE, data.length - TAG)), decipher.final()]);
  } catch (error) {
    throw new Error("couldn't decrypt (wrong key, or a damaged or misplaced file)", { cause: error });
  }
}

const commitAad = (chatId, commitId) => `skinny-commit\0${chatId}\0${commitId}`;
const blobAad = (chatId, name) => `skinny-blob\0${chatId}\0${name}`;

export function sealCommit(keys, chatId, commitId, payload) {
  return seal(COMMIT_MAGIC, keys.commit, deflateSync(Buffer.from(JSON.stringify(payload))), commitAad(chatId, commitId));
}

export function openCommit(keys, chatId, commitId, data) {
  return JSON.parse(inflateSync(open(COMMIT_MAGIC, keys.commit, data, commitAad(chatId, commitId))).toString('utf8'));
}

export const blobName = (keys, sha256) => createHmac('sha256', keys.name).update(sha256).digest('hex');

export function sealBlob(keys, chatId, name, bytes) {
  return seal(BLOB_MAGIC, keys.blob, bytes, blobAad(chatId, name));
}

// Returns the bytes, checking they're the ones the name stands for.
export function openBlob(keys, chatId, name, data) {
  const bytes = open(BLOB_MAGIC, keys.blob, data, blobAad(chatId, name));
  if (blobName(keys, createHash('sha256').update(bytes).digest('hex')) !== name) throw new Error('blob does not match its name');
  return bytes;
}
