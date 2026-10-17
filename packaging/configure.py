"""Swing Stocks setup. Credentials stay in ignored local files."""
import getpass
import hashlib
import json
import os
import re
from pathlib import Path


def main():
    os.umask(0o077)
    root, data = Path('/app'), Path('/data')
    (data / 'home').mkdir(parents=True, exist_ok=True)
    compose_env = root / '.env'
    if not compose_env.exists():
        compose_env.write_text(f'SWING_UID={os.getuid()}\nSWING_GID={os.getgid()}\n')
    env = root / 'swing-config/swing.env'
    env.parent.mkdir(exist_ok=True)
    if env.exists():
        print('Existing swing-config/swing.env preserved. Edit it locally to change settings.')
        if not (data / 'control.json').exists():
            (data / 'control.json').write_text(json.dumps({'paused': True}))
        return
    fields = {}
    for key, label in [
        ('ALPACA_KEY', 'Alpaca PAPER API key'),
        ('ALPACA_SECRET', 'Alpaca PAPER API secret'),
        ('TELEGRAM_BOT_TOKEN', 'Swing Telegram bot token (different from ORB bot)'),
        ('TELEGRAM_ALLOWED_CHAT_IDS', 'Your authorized Telegram numeric chat ID'),
        ('DASHBOARD_USER', 'Choose a Swing dashboard username'),
    ]:
        value = getpass.getpass(label + ': ').strip()
        if not value or any(c in value for c in "\n\r'$"):
            raise SystemExit('Value empty or contains unsupported characters; nothing saved.')
        fields[key] = value
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', fields['TELEGRAM_BOT_TOKEN']):
        raise SystemExit('Telegram token format invalid; nothing saved.')
    if not re.fullmatch(r'-?\d+(?:,-?\d+)*', fields['TELEGRAM_ALLOWED_CHAT_IDS']):
        raise SystemExit('Chat IDs must be numeric and comma-separated; nothing saved.')
    password = getpass.getpass('Dashboard password (at least 12 characters): ')
    if len(password) < 12 or password != getpass.getpass('Confirm password: '):
        raise SystemExit('Password confirmation failed; nothing saved.')
    fields.update(DASHBOARD_PASSWORD_HASH=hashlib.sha256(password.encode()).hexdigest(),
                  DRY_RUN='true', ALLOW_LIVE='false',
                  STRATEGIES='rsi2', MARKETS='US', WATCHLIST_SET='broad', BOT_LABEL='Swing RSI2')
    with env.open('x') as f:
        for k, v in fields.items():
            f.write(f"{k}='{v}'\n")
    env.chmod(0o600)
    print('Configuration saved. Workers start in DRY_RUN: no entry/exit orders are sent.')
    controls = data / 'control.json'
    if not controls.exists():
        controls.write_text(json.dumps({'paused': True}))
    print('Local controls saved. No Firebase or cloud account is required.')


if __name__ == '__main__':
    main()
