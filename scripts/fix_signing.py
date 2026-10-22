#!/usr/bin/env python3
"""CI helper: enforce fixed signing for Shivam Staff APK (v4 - self-verifying).

Steps:
1. Deletes corrupt/stale keystore files in android/app/ (release.keystore, *.jks,
   and any *.keystore that is not shivam.keystore).
2. Decodes keystore.b64 (repository root), verifies its SHA-256 byte-exact,
   writes it as android/app/shivam.keystore.
3. REPLACES the signingConfigs block(s) in android/app/build.gradle with the
   canonical shivam config (never appends a second block), and forces the
   debug + release buildTypes to sign with signingConfigs.shivam.
4. Final assertions: exits 1 with a clear message if ANYTHING is not exact.
"""
import base64
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(ROOT, 'android', 'app')
GRADLE = os.path.join(APP_DIR, 'build.gradle')
B64 = os.path.join(ROOT, 'keystore.b64')
KEYSTORE = os.path.join(APP_DIR, 'shivam.keystore')

# sha256 of the DECODED keystore bytes (verified backup: shivam-staff.keystore)
EXPECTED_BIN_SHA256 = '669ea91d0b7faf414d9d38f48c74ab59e3f4986c80854516fdb79adc24d3b2ce'
STORE_PASS = 'Shivam@2026'
KEY_ALIAS = 'shivamstaff'
KEY_PASS = 'Shivam@2026'


def die(msg):
    print('')
    print('==============================================')
    print('SIGNING SETUP FAILED: ' + msg)
    print('==============================================')
    sys.exit(1)


def find_block_span(text, header_pattern):
    """Return (start, end) span of the {...} block whose header matches the
    regex. Brace-counting, handles nesting. None if header not found."""
    m = re.search(header_pattern, text)
    if not m:
        return None
    start = m.start()
    open_idx = text.find('{', m.start())
    if open_idx == -1:
        die('malformed build.gradle near: ' + m.group(0).strip())
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return (start, i + 1)
    die('unbalanced braces in build.gradle near: ' + m.group(0).strip())


# ---------- 1) remove corrupt / stale keystore files ----------
os.makedirs(APP_DIR, exist_ok=True)
removed = []
for fn in sorted(os.listdir(APP_DIR)):
    path = os.path.join(APP_DIR, fn)
    if not os.path.isfile(path) or fn == 'shivam.keystore':
        continue
    if fn.endswith('.keystore') or fn.endswith('.jks'):
        os.remove(path)
        removed.append(fn)
if removed:
    print('[1/4] Deleted stale/corrupt keystore files: ' + ', '.join(removed))
else:
    print('[1/4] No stale keystore files in android/app (clean)')

# ---------- 2) decode + verify + write the real keystore ----------
if not os.path.exists(B64):
    die('keystore.b64 NOT FOUND at repository root. It must be committed to the repo.')
raw = ''.join(open(B64, 'r').read().split())
try:
    data = base64.b64decode(raw, validate=True)
except Exception as e:
    die('keystore.b64 is not valid base64: ' + str(e))
sha = hashlib.sha256(data).hexdigest()
print('[2/4] keystore.b64 decoded: %d bytes, sha256 %s' % (len(data), sha))
if len(data) < 1000:
    die('decoded keystore is only %d bytes - corrupt file' % len(data))
if sha != EXPECTED_BIN_SHA256:
    die('keystore.b64 CONTENT MISMATCH (expected sha256 ' + EXPECTED_BIN_SHA256
        + '). The keystore.b64 in the repo is wrong or was modified.')
with open(KEYSTORE, 'wb') as f:
    f.write(data)
print('[2/4] Wrote android/app/shivam.keystore (%d bytes)' % len(data))

# ---------- 3) patch build.gradle (REPLACE, never append) ----------
if not os.path.exists(GRADLE):
    die('android/app/build.gradle NOT FOUND')
s = open(GRADLE, 'r').read()
if '\r' in s:
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    print('[3/4] Normalised CRLF line endings in build.gradle')

SIGNING_BLOCK = (
    '    signingConfigs {\n'
    '        shivam {\n'
    "            storeFile file('shivam.keystore')\n"
    "            storePassword '" + STORE_PASS + "'\n"
    "            keyAlias '" + KEY_ALIAS + "'\n"
    "            keyPassword '" + KEY_PASS + "'\n"
    '        }\n'
    '    }'
)

# scan for ALL signingConfigs blocks: replace the first non-canonical one with
# the canonical block, delete any further non-canonical duplicates
canonical_pos = None
n_replaced = 0
n_deleted = 0
offset = 0
while True:
    sp = find_block_span(s[offset:], r'(?m)^[ \t]*signingConfigs[ \t]*\{')
    if not sp:
        break
    a, b = offset + sp[0], offset + sp[1]
    if s[a:b] == SIGNING_BLOCK:
        if canonical_pos is None:
            canonical_pos = a
        offset = b
        continue
    if canonical_pos is None:
        s = s[:a] + SIGNING_BLOCK + s[b:]
        canonical_pos = a
        n_replaced += 1
        offset = a + len(SIGNING_BLOCK)
    else:
        del_end = b + 1 if b < len(s) and s[b] == '\n' else b
        s = s[:a] + s[del_end:]
        n_deleted += 1
        offset = a
    if n_replaced + n_deleted > 6:
        die('too many signingConfigs blocks - build.gradle is malformed')

if canonical_pos is None:
    m = re.search(r'(?m)^android[ \t]*\{', s)
    if not m:
        die('cannot find "android {" in build.gradle')
    s = s[:m.end()] + '\n' + SIGNING_BLOCK + s[m.end():]
    print('[3/4] No signingConfigs existed - inserted canonical shivam block')
else:
    print('[3/4] signingConfigs: replaced %d, deleted %d non-canonical block(s)'
          % (n_replaced, n_deleted))

bt_span = find_block_span(s, r'(?m)^[ \t]*buildTypes[ \t]*\{')
if bt_span is None:
    die('buildTypes block not found in build.gradle - not a standard Capacitor gradle file')
bt = s[bt_span[0]:bt_span[1]]

# 3a. expand single-line sub-blocks like:  debug { signingConfig signingConfigs.xyz }
for tn in ('debug', 'release'):
    pat = re.compile(r'(?m)^([ \t]*)' + tn + r'[ \t]*\{[^}\n]*\}[ \t]*$')
    m2 = pat.search(bt)
    if m2:
        ind = m2.group(1)
        bt = bt[:m2.start()] + ind + tn + ' {\n' + ind + '}\n' + bt[m2.end():]

# 3b. drop every existing signingConfig line inside buildTypes
bt = '\n'.join(ln for ln in bt.split('\n')
               if not re.match(r'^[ \t]*signingConfig[ \t]', ln))

# 3c. ensure our signingConfig line inside debug and release sub-blocks
for tn in ('debug', 'release'):
    m3 = re.search(r'(?m)^([ \t]*)' + tn + r'[ \t]*\{[ \t]*$', bt)
    if m3:
        ind = m3.group(1) + '    '
        bt = bt[:m3.end()] + '\n' + ind + 'signingConfig signingConfigs.shivam' + bt[m3.end():]
    else:
        close = bt.rfind('}')
        bt = (bt[:close]
              + '        ' + tn + ' {\n'
              + '            signingConfig signingConfigs.shivam\n'
              + '        }\n'
              + bt[close:])
print('[3/4] buildTypes debug + release now sign with signingConfigs.shivam')

s = s[:bt_span[0]] + bt + s[bt_span[1]:]
with open(GRADLE, 'w') as f:
    f.write(s)

# ---------- 4) final assertions ----------
final = open(GRADLE, 'r').read()
if 'release.keystore' in final:
    die('build.gradle STILL references release.keystore after patching - '
        'the build.gradle replacement (TASK 4) was not applied correctly')
if 'shivamkey' in final:
    die("build.gradle STILL references old alias 'shivamkey'")
if "storeFile file('shivam.keystore')" not in final:
    die("build.gradle missing: storeFile file('shivam.keystore')")
if "keyAlias '" + KEY_ALIAS + "'" not in final:
    die("build.gradle missing: keyAlias 'shivamstaff'")
dbg = re.search(r'(?ms)^[ \t]*debug[ \t]*\{.*?^[ \t]*\}', final)
rel = re.search(r'(?ms)^[ \t]*release[ \t]*\{.*?^[ \t]*\}', final)
if not dbg or 'signingConfig signingConfigs.shivam' not in dbg.group(0):
    die('debug buildType does not sign with signingConfigs.shivam')
if not rel or 'signingConfig signingConfigs.shivam' not in rel.group(0):
    die('release buildType does not sign with signingConfigs.shivam')
print('[4/4] Verified: shivam.keystore / alias shivamstaff / debug+release signed')
print('ALL SIGNING CHECKS PASSED')
