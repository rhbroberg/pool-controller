Setting up a Raspberry Pi 4 to run the pool controller. Last tried with Raspberry Pi OS Lite
(64-bit).

* DNS at he.net

The public name needs an A record (and an AAAA record if the Pi is reachable over IPv6) with
'enable entry for dynamic dns' checked and a TTL of 5 minutes. Click the refresh icon in the DDNS
column, then 'generate a key'; those keys are $my4key and $my6key below.

For the certificate, add a TXT record named _acme-challenge.<the name> the same way, with any
value; its DDNS key (not its value) is POOL_HE_DDNS_KEY. README.md, "Setting it up from
nothing", has the steps and a way to check the key.

* router

Forward port 443 (the page, and the REST API under it) to the Pi for whoever uses them from
outside; port 80 only redirects to 443 and needn't be forwarded. Let's Encrypt needs neither,
since the certificate is proved through DNS.

* the Pi

Write Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager, choosing the user name, password and
ssh key in its settings, then:

    sudo apt-get update && sudo apt-get full-upgrade -y
    sudo reboot

* dynamic DNS

Keep the A and AAAA records pointing at this network by adding these lines to the user's crontab,
using your keys and name:

    my4key=<generated key string for ipv4>
    my6key=<generated key string for ipv6>
    myhostname=<your-chosen-public-hostname>

    crontab - << EOF
    */15 * * * * curl -4 -s "https://$myhostname:$my4key@dyn.dns.he.net/nic/update?hostname=$myhostname"
    */15 * * * * curl -6 -s "https://$myhostname:$my6key@dyn.dns.he.net/nic/update?hostname=$myhostname"
    EOF

* Docker, with the compose plugin

    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    newgrp docker

* the project

    git clone https://github.com/rhbroberg/pool-controller.git
    cd pool-controller/docker

Set POOL_HOSTNAME and POOL_ACME_EMAIL in .env, and for the first try POOL_ACME_CA to Let's
Encrypt's staging CA, then start it with the secrets in the environment:

    export POOL_JWT_SECRET=$(openssl rand -hex 32)   # keep it; a new one signs everyone out
    export POOL_HE_DDNS_KEY='<the _acme-challenge record's DDNS key>'
    make up
    make logs    # caddy logs "certificate obtained successfully" within a minute or two

Once it has, set POOL_ACME_CA back to production and run make up again (README.md, step 7).
