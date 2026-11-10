import sys, re
cfg = open('config/app.yaml').read()
def val(key):
    m = re.search(r'^\s*' + key + r':\s*(\S+)', cfg, re.M); return m.group(1) if m else None
errs = []
if ':' in (val('host') or ''): errs.append('db.host must not contain a port')
if int(val('pool_size') or 0) < 20: errs.append('db.pool_size must be >= 20')
if int(val('timeout_s') or 0) <= 0: errs.append('db.timeout_s must be > 0')
print('\n'.join(errs) or 'OK'); sys.exit(1 if errs else 0)
