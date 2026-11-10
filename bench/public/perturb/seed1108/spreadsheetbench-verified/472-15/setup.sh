set -e
mkdir -p /data/sheets /data/results
mv /app/spreadsheets/* /data/sheets/
rmdir /app/spreadsheets /app/output 2>/dev/null || true
