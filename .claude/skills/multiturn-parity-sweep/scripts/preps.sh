# preps.sh <bin> <tag> <n> <port>
for i in $(seq 1 $3); do timeout 700 python3 pdrive.py $1 $2-r$i --port $4 > plog-$2-r$i.log 2>&1; done
