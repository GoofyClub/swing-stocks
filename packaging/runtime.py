"""Portable Swing Stocks supervisor; existing Node workers retain trading decisions."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('SWING_DATA_DIR', ROOT / 'data'))
STOP = False


def stopping(*_):
    global STOP
    STOP = True


@contextlib.contextmanager
def lock(name, blocking=False):
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / name).open('a') as f:
        fcntl.flock(f, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def atomic_json(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value))
    tmp.replace(path)


def validate():
    for key in ('ALPACA_KEY', 'ALPACA_SECRET', 'TELEGRAM_BOT_TOKEN',
                'TELEGRAM_ALLOWED_CHAT_IDS', 'DASHBOARD_USER', 'DASHBOARD_PASSWORD_HASH'):
        if not os.environ.get(key):
            raise RuntimeError(f'{key} missing: run the configuration assistant')
    if not re.fullmatch(r'[a-fA-F0-9]{64}', os.environ['DASHBOARD_PASSWORD_HASH']):
        raise RuntimeError('Dashboard password hash invalid')
    if not (DATA / 'control.json').exists():
        raise RuntimeError('Local controls missing; run the configuration assistant')
    (DATA / 'home').mkdir(exist_ok=True)


def due_jobs(now, completed, broad=False):
    """DST-aware VM-equivalent schedule; never catch up an expired entry window."""
    from zoneinfo import ZoneInfo
    local = now.astimezone(ZoneInfo('America/New_York'))
    if local.weekday() >= 5:
        return []
    day = local.date().isoformat()
    minute = local.hour * 60 + local.minute
    jobs = []
    for name, threshold in [('morning', 585), ('close', 975)]:
        key = f'{day}:maintenance:{name}'
        if minute >= threshold and not completed.get(key, {}).get('done'):
            jobs.append((key, 'packaging/local-worker.mjs maintenance'))
    threshold = 938 if broad else 942
    key = f'{day}:entry'
    if threshold <= minute < 950 and not completed.get(key, {}).get('done'):
        jobs.append((key, 'packaging/local-worker.mjs entry'))
    return jobs


def scheduler():
    import datetime as dt
    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)
    path = DATA / 'schedule.json'
    completed = json.loads(path.read_text()) if path.exists() else {}
    while not STOP:
        try:
            with lock('.tick.lock'):
                for key, script in due_jobs(dt.datetime.now(dt.timezone.utc), completed,
                                            os.environ.get('WATCHLIST_SET') == 'broad'):
                    if STOP:
                        break
                    if time.time() - completed.get(key, {}).get('at', 0) < 300:
                        continue
                    completed[key] = {'at': time.time(), 'done': False}
                    atomic_json(path, completed)
                    try:
                        result = subprocess.run(['node', *script.split()], cwd=ROOT, timeout=1200)
                        completed[key]['done'] = result.returncode == 0
                    except subprocess.TimeoutExpired:
                        print(f'{script} timed out; next eligible pass will retry', flush=True)
                    completed = {k: v for k, v in completed.items() if time.time() - v['at'] < 45 * 86400}
                    atomic_json(path, completed)
            atomic_json(DATA / 'scheduler.json', {'at': time.time()})
        except BlockingIOError:
            pass
        for _ in range(30):
            if STOP:
                break
            time.sleep(1)


def stop_children(children):
    # Scheduler finishes its current bounded tick before exiting. This avoids
    # interrupting a cancel/close or an accepted-entry/state-save sequence.
    for child in children.values():
        if child.poll() is None:
            child.terminate()
    for child in children.values():
        try:
            child.wait(timeout=1205)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def supervise():
    os.umask(0o077)
    validate()
    with lock('.instance.lock'):
        signal.signal(signal.SIGTERM, stopping)
        signal.signal(signal.SIGINT, stopping)
        commands = {'scheduler': [sys.executable, __file__, 'scheduler'],
                    'telegram': ['node', str(ROOT / 'packaging/local-bot.mjs')],
                    'dashboard': ['node', str(ROOT / 'packaging/local-dashboard.mjs')]}
        children = {}
        restart = DATA / 'restart.json'
        try:
            while not STOP:
                for name, command in commands.items():
                    old = children.get(name)
                    if old is None or old.poll() is not None:
                        if old is not None:
                            print(f'{name} exited ({old.returncode}); restarting', flush=True)
                        children[name] = subprocess.Popen(command, cwd=ROOT)
                atomic_json(DATA / 'runtime.json', {'at': time.time(),
                            'children': {k: p.pid for k, p in children.items()}})
                if restart.exists() and time.time() - restart.stat().st_mtime >= 5:
                    restart.unlink()
                    stop_children(children)
                    # Reload supervisor as well as application code after deploy.
                    os.execv(sys.executable, [sys.executable, str(ROOT / 'packaging/runtime.py')])
                time.sleep(2)
        finally:
            stop_children(children)


def health():
    validate()
    runtime = json.loads((DATA / 'runtime.json').read_text())
    if time.time() - runtime['at'] > 15:
        raise RuntimeError('Supervisor heartbeat stale')
    for name, pid in runtime['children'].items():
        os.kill(pid, 0)
        print(name + ': running')
    tick = json.loads((DATA / 'scheduler.json').read_text())
    if time.time() - tick['at'] > 1300:
        raise RuntimeError('Scheduler stale (a tick may have hung)')
    user = os.environ['DASHBOARD_USER']
    # Healthz requires auth, but a password hash cannot authenticate as a
    # password. Use a TCP probe here to avoid counting failed login attempts.
    import socket
    with socket.create_connection(('127.0.0.1', int(os.environ.get('DASHBOARD_PORT', 8080))), timeout=3):
        pass
    print('Workers: DRY RUN' if os.environ.get('DRY_RUN', 'true').lower() != 'false' else 'Workers: paper order execution enabled')
    print('Schedule: maintenance 09:45/16:15 ET; entries 15:38 broad / 15:42 core ET')
    print('Process checks only; verify broker/Telegram connectivity separately.')


def verify():
    validate()
    result = subprocess.run(['node', 'packaging/verify.mjs'], cwd=ROOT)
    if result.returncode:
        raise RuntimeError('Connectivity verification failed; keep DRY_RUN=true')


def deploy(branch='main'):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', branch) or '..' in branch:
        raise RuntimeError('Invalid branch name')
    # Commands in Telegram enforce this too. Do not change code during a tick.
    with lock('.tick.lock', blocking=True):
        def git(*args):
            return subprocess.check_output(['git', *args], cwd=ROOT, stderr=subprocess.STDOUT, text=True, timeout=45).strip()
        if git('status', '--porcelain', '--untracked-files=no'):
            raise RuntimeError('Tracked local changes exist; commit or resolve them before deploying')
        git('fetch', '--quiet', 'origin', branch)
        target = git('rev-parse', 'FETCH_HEAD')
        git('merge-base', '--is-ancestor', 'HEAD', target)
        for name in ('Dockerfile', 'compose.yaml'):
            if git('diff', '--name-only', 'HEAD', target, '--', name):
                raise RuntimeError('Container configuration changed: update and rebuild on the PC')
        import datetime as dt
        from zoneinfo import ZoneInfo
        now = dt.datetime.now(ZoneInfo('America/New_York'))
        if now.weekday() < 5 and 930 <= now.hour * 60 + now.minute <= 965:
            raise RuntimeError('Updates refused inside the 15:30–16:05 ET execution window')
        if '--check' in sys.argv:
            print(f'Fast-forward update available: {target[:7]}; no changes made')
            return
        # Existing suite verifies prospective source before services reload.
        previous = git('rev-parse', '--short', 'HEAD')
        git('merge', '--ff-only', target)
        result = subprocess.run(['node', '--test', 'tests/local-runtime.mjs'], cwd=ROOT)
        if result.returncode:
            git('reset', '--hard', previous)
            raise RuntimeError('Tests failed; checkout restored and services left running')
        atomic_json(DATA / 'restart.json', {'at': time.time()})
        print(f'Updated {previous} -> {target[:7]}; graceful service reload queued.')


def flatten():
    with lock('.tick.lock', blocking=True):
        subprocess.run(['node', 'packaging/local-worker.mjs', 'flatten'], cwd=ROOT, check=True)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else 'run'
    try:
        {'run': supervise, 'scheduler': scheduler, 'health': health, 'verify': verify,
         'flatten': flatten, 'deploy': lambda: deploy(sys.argv[2] if len(sys.argv) > 2 else 'main')}[command]()
    except Exception as e:
        if isinstance(e, subprocess.CalledProcessError):
            print('Git operation failed. Check private repository access, branch and fast-forward history.', file=sys.stderr)
        else:
            print(str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
