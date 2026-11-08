Set up this machine so that, from my laptop, I can do

    git clone user@server:/srv/repos/site
    echo "site is live" > status.html
    git add status.html
    git commit -m "add status page"
    git push origin master

and the pushed file is then served by a web server on port 8181, i.e. `curl http://server:8181/status.html` prints `site is live`. Authentication is handled on my side; don't worry about login.
