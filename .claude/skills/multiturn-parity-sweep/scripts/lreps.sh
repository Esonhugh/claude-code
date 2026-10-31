# lreps.sh <bin> <tag> <n> <port>
for i in $(seq 1 $3); do ROUNDS=3 timeout 1200 python3 ldrive.py $1 $2-r$i --port $4 > llog-$2-r$i.log 2>&1; tail -1 llog-$2-r$i.log; done
