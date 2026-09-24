"""Audit every outgoing Git blob and push only an explicit fork branch. No force push."""
import argparse
import json
from pathlib import Path
import re
import subprocess

REMOTE = 'fork'
BRANCH = 'refs/heads/yyn/customized-branch'
EXPECTED_URL = 'https://github.com/coderyyn/AIClient2API.git'
SECRET = re.compile(rb'(-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|'
                    rb'\b(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}|'
                    rb'\bsk-[A-Za-z0-9_-]{32,}|'
                    rb'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})')
FIELD = re.compile(rb'"(?:access_token|refresh_token|client_secret|password|api[_-]?key|REQUIRED_API_KEY)"\s*:\s*"([^"\r\n]{8,})"', re.I)
SENSITIVE_PATH = re.compile(r'(^|/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|.*(?:oauth_creds|auth-token).*\.json)$|\.(?:sqlite\d*|db|tar|tar\.gz|zip|pem|key)$', re.I)


def git(*args):
    return subprocess.check_output(['git', *args])


def remote_head():
    value = git('ls-remote', REMOTE, BRANCH).decode().split()
    if not value:
        raise ValueError('expected fork branch is missing')
    return value[0]


def scan_blob(content, path, size):
    reasons = []
    if size > 10 * 1024 * 1024:
        reasons.append('large_blob_over_10MiB')
    if SENSITIVE_PATH.search(path):
        reasons.append('sensitive_or_artifact_path')
    if '/experiments/' in '/' + path or path.startswith(('outputs/', '.plans/', '.zcode/', 'docker-data/')):
        reasons.append('local_artifact_path')
    if SECRET.search(content):
        reasons.append('credential_pattern')
    for match in FIELD.finditer(content):
        value = match[1].lower()
        # Examples need review too unless unmistakably synthetic. No values are emitted.
        if value in (b'access_token', b'access-token', b'refresh_token', b'refresh-token'):
            continue
        if not value.endswith(b'...') and not any(x in value for x in (b'example', b'placeholder', b'your-', b'your_', b'test-', b'test_', b'fake-', b'dummy', b'123456')):
            reasons.append('credential_field_requires_review')
            break
    return reasons


def audit(head):
    if git('remote', 'get-url', '--push', REMOTE).decode().strip() != EXPECTED_URL:
        raise ValueError('fork push URL mismatch')
    base = remote_head()
    git('cat-file', '-e', base + '^{commit}')
    git('merge-base', '--is-ancestor', base, head)
    objects = git('rev-list', '--objects', base + '..' + head).decode().splitlines()
    findings = []
    checked = 0
    # One metadata process and one content process for the entire range, rather
    # than thousands of Windows process launches.
    object_paths = dict(row.partition(' ')[::2] for row in objects)
    metadata = subprocess.check_output(['git', 'cat-file', '--batch-check'],
                                       input=('\n'.join(object_paths) + '\n').encode()).decode().splitlines()
    blobs = []
    for row in metadata:
        oid, kind, size_text = row.split()
        if kind != 'blob':
            continue
        blobs.append((oid, object_paths[oid], int(size_text)))
    process = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
      for oid, path, size in blobs:
        content = b''
        if size <= 50 * 1024 * 1024:
            process.stdin.write((oid + '\n').encode())
            process.stdin.flush()
            header = process.stdout.readline().decode().split()
            if header != [oid, 'blob', str(size)]:
                raise ValueError('unexpected Git blob response')
            content = process.stdout.read(size)
            if len(content) != size or process.stdout.read(1) != b'\n':
                raise ValueError('incomplete Git blob response')
        checked += 1
        reasons = scan_blob(content, path, size)
        if reasons:
            findings.append({'blob': oid, 'path': path, 'bytes': size, 'reasons': reasons})
    finally:
        process.stdin.close()
        process.stdout.close()
        process.wait()
    return {'head': head, 'remoteBase': base, 'remote': REMOTE, 'branch': BRANCH,
            'outgoingCommits': int(git('rev-list', '--count', base + '..' + head)),
            'checkedBlobs': checked, 'findings': findings, 'push': 'not_run'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--report', required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--reviewed', help='JSON list of exact blob/path/reasons/reviewNote records reviewed as safe')
    args = p.parse_args()
    head = git('rev-parse', 'HEAD').decode().strip()
    result = audit(head)
    if args.reviewed:
        reviews = json.loads(Path(args.reviewed).read_text(encoding='utf-8'))
        accepted = []
        remaining = []
        for finding in result['findings']:
            review = next((r for r in reviews if r.get('blob') == finding['blob'] and r.get('path') == finding['path']
                           and r.get('reasons') == finding['reasons'] and r.get('reviewNote', '').strip()), None)
            (accepted if review else remaining).append(finding | ({'reviewNote': review['reviewNote']} if review else {}))
        result['reviewedFindings'] = accepted
        result['findings'] = remaining
    path = Path(args.report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key not in ('findings', 'reviewedFindings')}
                     | {'findingCount': len(result['findings']), 'reviewedCount': len(result.get('reviewedFindings', []))}))
    if args.apply:
        if result['findings']:
            raise ValueError('outgoing history needs review; no push performed')
        if git('status', '--porcelain').strip():
            raise ValueError('uncommitted files are not part of a release push')
        if remote_head() != result['remoteBase'] or git('rev-parse', 'HEAD').decode().strip() != head:
            raise ValueError('branch moved during audit; repeat audit')
        git('push', REMOTE, head + ':' + BRANCH)
        if remote_head() != head:
            raise ValueError('remote SHA verification failed')
        result['push'] = 'verified'
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print('fork push verified: ' + head)


if __name__ == '__main__':
    main()
