#!/usr/bin/env python3
"""Check init-script argument handling without requiring a running OpenWrt router."""
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
init = root / 'openwrt/files/etc/init.d/bufferbloat-test'
harness = r'''
config_load() { :; }
config_get() {
    value=$(printenv "TEST_$3") || value=$4
    export "$1=$value"
}
procd_open_instance() { :; }
procd_close_instance() { :; }
procd_set_param() { if [ "$1" = command ]; then shift; printf '%s\n' "$@"; fi; }
procd_add_reload_trigger() { printf 'reload:%s\n' "$1"; }
. "$1"
start_service || exit $?
service_triggers
'''

def run(**settings):
    env = {k: v for k, v in os.environ.items() if not k.startswith('TEST_')}
    env.update({'TEST_' + k: v for k, v in settings.items()})
    return subprocess.run(['sh', '-c', harness, 'test', str(init)], env=env,
                          text=True, capture_output=True)

result = run()
assert result.returncode == 0, result.stderr
assert result.stdout.splitlines() == [
    '/usr/bin/bufferbloat-test', '-listen', ':8080', '-max-concurrent', '1',
    '-download-streams', '4', '-upload-streams', '2', '-lock-ttl', '90s',
    'reload:bufferbloat-test']
result = run(listen='[::1]:9090', max_concurrent='2', download_streams='5',
             upload_streams='3', lock_ttl='120')
assert result.returncode == 0, result.stderr
assert result.stdout.splitlines()[1:] == [
    '-listen', '[::1]:9090', '-max-concurrent', '2', '-download-streams', '5',
    '-upload-streams', '3', '-lock-ttl', '120s', 'reload:bufferbloat-test']
# Values must remain single arguments, never shell commands or extra flags.
result = run(listen=':8080 -max-concurrent 99; echo unexpected')
assert result.stdout.splitlines()[2] == ':8080 -max-concurrent 99; echo unexpected'
for option in ['max_concurrent', 'download_streams', 'upload_streams', 'lock_ttl']:
    for value in ['0', '-1', 'abc', '90s', '1 2', '01', '']:
        result = run(**{option: value})
        assert result.returncode != 0 and not result.stdout, (option, value, result)
makefile = (root / 'openwrt/Makefile').read_text()
assert 'define Package/bufferbloat-test/conffiles\n/etc/config/bufferbloat-test' in makefile
assert '$(INSTALL_CONF) ./files/etc/config/bufferbloat-test $(1)/etc/config/bufferbloat-test' in makefile
print('OpenWrt defaults, overrides, validation, quoting, reload trigger and packaging: PASS')
