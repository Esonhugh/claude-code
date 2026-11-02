# rreps.sh <bin> <tag> <from> <to>
for i in $(seq $3 $4); do timeout 3000 python3 rdrive.py $1 $2-$i > rlog-$2-$i.log 2>&1; done
