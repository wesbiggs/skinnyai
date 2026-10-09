import { chmodSync, statSync } from 'node:fs';

// The directories skinnyai makes for its own files (~/.skinny, sessions/)
// are for you alone: 0700, so other accounts on the machine can't list or
// open the chats inside. This tightens one that already exists and is looser
// than that (earlier versions made them 0755). Only the default ~/.skinny is
// touched, never a directory you pointed SKINNY_HOME at.
export function tightenDir(dir) {
  try {
    if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
    return true;
  } catch (error) {
    return false;
  }
}
