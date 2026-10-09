import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/sessions-volume.sh against stand-ins for diskutil, hdiutil, mount,
// and security, so it runs anywhere. A "mounted" volume is a symlink from the
// mount point to the image's data folder; ejecting puts back an empty folder.
// (The script was also run for real against macOS disk images.)
const SCRIPT = fileURLToPath(new URL('../scripts/sessions-volume.sh', import.meta.url));
let tmp;
let env;
let mountPoint;

const SHIMS = {
  diskutil: `#!/bin/bash
S="$SHIM_STATE"; mkdir -p "$S"
if [ "$1" = image ] && [ $# -eq 1 ]; then
  if [ -n "\${SHIM_NO_DISKUTIL_IMAGE:-}" ]; then echo 'diskutil: unrecognized verb "image"' >&2; exit 1; fi
  echo "USAGE: diskutil image [--verbose] <subcommand>"; exit 0
fi
if [ "$1" = eject ]; then
  M="$2"; real="$(cd -P "$M" && pwd -P)"
  grep -qxF "$real" "$S/mounts" 2>/dev/null || exit 1
  grep -vxF "$real" "$S/mounts" > "$S/mounts.new"; mv "$S/mounts.new" "$S/mounts"
  rm "$M"; mkdir "$M"; chmod 500 "$M"; echo "ejected"; exit 0
fi
[ "$1" = image ] || exit 2
shift; [ "$1" = --stdinpass ] || { echo "no passphrase on stdin: a dialog would open" >&2; exit 9; }
shift; pass="$(cat)"; verb="$1"; shift
if [ "$verb" = create ]; then
  img="\${@: -1}"; mkdir -p "$img/data"; printf '%s' "$pass" > "$img/pass"; exit 0
fi
if [ "$verb" = attach ]; then
  img="\${@: -1}"; M=""
  while [ $# -gt 0 ]; do [ "$1" = --mountPoint ] && M="$2"; shift; done
  [ "$pass" = "$(cat "$img/pass")" ] || { echo "Error: Incorrect passphrase" >&2; exit 1; }
  rmdir "$M" && ln -s "$(cd -P "$img/data" && pwd -P)" "$M" && (cd -P "$M" && pwd -P) >> "$S/mounts"; exit 0
fi
exit 2
`,
  hdiutil: `#!/bin/bash
S="$SHIM_STATE"; mkdir -p "$S"
verb="$1"; shift
if [ "$verb" = create ]; then pass="$(cat)"; img="\${@: -1}"; mkdir -p "$img/data"; printf '%s' "$pass" > "$img/pass"; exit 0; fi
if [ "$verb" = attach ]; then
  pass="$(cat)"; img="\${@: -1}"; M=""
  while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && M="$2"; shift; done
  [ "$pass" = "$(cat "$img/pass")" ] || exit 1
  rmdir "$M" && ln -s "$(cd -P "$img/data" && pwd -P)" "$M" && (cd -P "$M" && pwd -P) >> "$S/mounts"; exit 0
fi
exit 2
`,
  mount: `#!/bin/bash
while read -r line; do echo "/dev/disk99 on $line (apfs, local, nobrowse)"; done < "\${SHIM_STATE}/mounts" 2>/dev/null; exit 0
`,
  security: `#!/bin/bash
S="$SHIM_STATE/keychain"; mkdir -p "$S"
if [ "$1" = -i ]; then read -r line; eval "set -- $line"; fi
verb="$1"; shift; a=""; pass=""
while [ $# -gt 0 ]; do case "$1" in -a) a="$2"; shift ;; -w) pass="$2"; shift ;; -s) shift ;; esac; shift; done
key="$(printf '%s' "$a" | tr '/ ' '__')"
if [ "$verb" = add-generic-password ]; then printf '%s' "$pass" > "$S/$key"; exit 0; fi
if [ "$verb" = find-generic-password ]; then [ -f "$S/$key" ] && cat "$S/$key" && exit 0; exit 44; fi
if [ "$verb" = delete-generic-password ]; then rm -f "$S/$key"; exit 0; fi
exit 1
`
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-volume-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  for (const [name, text] of Object.entries(SHIMS)) {
    fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
  }
  mountPoint = path.join(tmp, 'home', 'sessions');
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: tmp,
    SKINNY_HOME: path.join(tmp, 'home'),
    SHIM_STATE: path.join(tmp, 'state')
  };
  fs.mkdirSync(mountPoint, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (args, extra = {}) => {
  const result = spawnSync('bash', [SCRIPT, ...args], { env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const mode = (p) => fs.statSync(p).mode & 0o777;
const passFrom = (out) => out.match(/^PASSPHRASE: ([0-9a-f]{8}(?:-[0-9a-f]{8}){7})$/m)?.[1];

describe('sessions-volume.sh', () => {
  it('sets up, locks, and unlocks a volume, moving existing chats into it', () => {
    fs.writeFileSync(path.join(mountPoint, 'old.skinny'), 'a chat');
    expect(run(['status'])).toMatchObject({ code: 4, out: 'state=off\n' });

    const setup = run(['setup', '--keep-originals']);
    expect(setup.code).toBe(0);
    const pass = passFrom(setup.out);
    expect(pass).toBeTruthy();
    expect(setup.out).toMatch(/ORIGINALS: .*sessions\.plain-/);
    expect(fs.readdirSync(mountPoint).sort()).toEqual(['.skinny-encrypted', 'old.skinny']);
    expect(fs.readFileSync(path.join(mountPoint, 'old.skinny'), 'utf8')).toBe('a chat');
    expect(run(['status'])).toMatchObject({ code: 0, out: 'state=unlocked\n' });
    // the passphrase is in the keychain, and is what created the image
    const stored = fs.readFileSync(path.join(tmp, 'state', 'keychain', fs.readdirSync(path.join(tmp, 'state', 'keychain'))[0]), 'utf8');
    expect(stored).toBe(pass.replaceAll('-', ''));
    expect(fs.readFileSync(path.join(tmp, 'home', 'sessions.sparsebundle', 'pass'), 'utf8')).toBe(stored);

    expect(run(['lock'])).toMatchObject({ code: 0 });
    expect(run(['status'])).toMatchObject({ code: 3, out: 'state=locked\n' });
    expect(fs.readdirSync(mountPoint)).toEqual([]);
    expect(mode(mountPoint)).toBe(0o500); // nothing can be written while it's locked

    expect(run(['unlock'])).toMatchObject({ code: 0 });
    expect(fs.readFileSync(path.join(mountPoint, 'old.skinny'), 'utf8')).toBe('a chat');
    expect(run(['passphrase']).out.trim()).toBe(pass);

    const originals = fs.readdirSync(path.join(tmp, 'home')).filter((f) => f.startsWith('sessions.plain-'));
    expect(originals).toHaveLength(1);
    expect(run(['delete-originals', '--yes']).out).toContain('Deleted');
    expect(fs.readdirSync(path.join(tmp, 'home')).filter((f) => f.startsWith('sessions.plain-'))).toEqual([]);
    expect(run(['delete-originals', '--yes']).out).toContain('No unencrypted originals');
  });

  it('can delete the originals right away, and sets up with nothing to move', () => {
    fs.writeFileSync(path.join(mountPoint, 'old.skinny'), 'a chat');
    const setup = run(['setup', '--delete-originals']);
    expect(setup.code).toBe(0);
    expect(setup.out).not.toContain('ORIGINALS');
    expect(fs.readdirSync(path.join(tmp, 'home')).filter((f) => f.startsWith('sessions.plain-'))).toEqual([]);
    const fresh = path.join(tmp, 'other');
    fs.mkdirSync(fresh);
    const second = run(['setup'], { SKINNY_HOME: fresh, SKINNY_SESSIONS_MOUNT: path.join(fresh, 'chats') });
    expect(second.code).toBe(0);
    expect(fs.readdirSync(path.join(fresh, 'chats'))).toEqual(['.skinny-encrypted']);
  });

  it('puts everything back and changes nothing if the copy does not check out', () => {
    fs.writeFileSync(path.join(mountPoint, 'old.skinny'), 'a chat');
    const bin = path.join(tmp, 'bin');
    fs.writeFileSync(path.join(bin, 'diff'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    const setup = run(['setup', '--delete-originals']);
    expect(setup.code).toBe(1);
    expect(setup.err).toContain("didn't check out");
    expect(fs.readFileSync(path.join(mountPoint, 'old.skinny'), 'utf8')).toBe('a chat');
    expect(fs.existsSync(path.join(tmp, 'home', 'sessions.sparsebundle'))).toBe(false);
    expect(run(['status']).code).toBe(4);
  });

  it('refuses to set up twice', () => {
    expect(run(['setup', '--keep-originals']).code).toBe(0);
    const again = run(['setup']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already set up');
  });

  it('uses hdiutil where diskutil has no image command', () => {
    const setup = run(['setup'], { SHIM_NO_DISKUTIL_IMAGE: '1' });
    expect(setup.code).toBe(0);
    expect(run(['lock'], { SHIM_NO_DISKUTIL_IMAGE: '1' }).code).toBeDefined();
  });

  it('never asks diskutil for a passphrase it was not given', () => {
    run(['setup']);
    run(['lock']);
    const wrong = run(['unlock'], { SKINNY_SESSIONS_PASSPHRASE: 'deadbeef' });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('wrong passphrase');
    // no keychain item and no terminal to ask on: it stops instead of prompting
    fs.rmSync(path.join(tmp, 'state', 'keychain'), { recursive: true });
    const none = run(['unlock']);
    expect(none.code).toBe(5);
    expect(none.err).toContain('no passphrase');
    expect(run(['status']).code).toBe(3);
  });

  it('accepts a passphrase typed in any case, with or without dashes', () => {
    const setup = run(['setup']);
    const pass = passFrom(setup.out);
    run(['lock']);
    fs.rmSync(path.join(tmp, 'state', 'keychain'), { recursive: true });
    const unlock = run(['unlock'], { SKINNY_SESSIONS_PASSPHRASE: pass.toUpperCase() });
    expect(unlock.code).toBe(0);
  });

  it('will not treat a mounted volume without its marker as the encrypted sessions', () => {
    run(['setup']);
    fs.rmSync(path.join(mountPoint, '.skinny-encrypted'));
    run(['lock']); // still mounted as far as the script can tell, so eject it by hand
    const result = run(['unlock']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('missing its marker');
    expect(run(['status']).code).toBe(3); // it was ejected again
  });

  it('refuses to mount over a folder that has files in it', () => {
    run(['setup']);
    run(['lock']);
    fs.chmodSync(mountPoint, 0o700);
    fs.writeFileSync(path.join(mountPoint, 'stray.skinny'), 'plain');
    const result = run(['unlock']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('has files in it');
  });

  it('locks after a command only when nothing else is using the volume', () => {
    run(['setup']);
    expect(run(['run', '--', 'true']).code).toBe(0);
    expect(run(['status']).code).toBe(3);

    run(['unlock']);
    const users = path.join(tmp, 'home', 'volume-users');
    fs.mkdirSync(users, { recursive: true });
    fs.writeFileSync(path.join(users, String(process.pid)), ''); // a live process
    run(['lock', '--if-idle']);
    expect(run(['status']).code).toBe(0); // still in use
    fs.rmSync(path.join(users, String(process.pid)));
    fs.writeFileSync(path.join(users, '999999999'), ''); // a process that is gone
    run(['lock', '--if-idle']);
    expect(run(['status']).code).toBe(3);
    expect(fs.existsSync(path.join(users, '999999999'))).toBe(false);

    expect(run(['run', '--keep-mounted', '--', 'true']).code).toBe(0);
    expect(run(['status']).code).toBe(0);
    expect(run(['run', '--', 'false']).code).toBe(1); // the command's own result
  });

  it('turns encryption off by copying the chats back out', () => {
    fs.writeFileSync(path.join(mountPoint, 'old.skinny'), 'a chat');
    run(['setup', '--delete-originals']);
    fs.writeFileSync(path.join(mountPoint, 'new.skinny'), 'newer');
    const off = run(['off']);
    expect(off.code).toBe(0);
    expect(fs.readdirSync(mountPoint).sort()).toEqual(['new.skinny', 'old.skinny']);
    expect(mode(mountPoint)).toBe(0o700);
    // it no longer counts as set up, the old image keeps its passphrase, and it can be set up again
    expect(run(['status']).code).toBe(4);
    expect(fs.existsSync(path.join(tmp, 'home', 'sessions.sparsebundle.disabled'))).toBe(true);
    const keychain = path.join(tmp, 'state', 'keychain');
    expect(fs.readdirSync(keychain)).toHaveLength(1);
    expect(fs.readFileSync(path.join(keychain, fs.readdirSync(keychain)[0]), 'utf8')).toBe(fs.readFileSync(path.join(tmp, 'home', 'sessions.sparsebundle.disabled', 'pass'), 'utf8'));
    expect(run(['setup', '--keep-originals']).code).toBe(0);
    expect(fs.readdirSync(keychain)).toHaveLength(2);
  });
});
