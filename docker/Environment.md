make sure your hostname for the pi is registered in dns; use something like dyndns.  I'm using he.net:

* prepare for LetsEncrypt container success: if you don't do this, the LetsEncrypt container will fail to retrieve a certificate for you and https will fail
if you want an ipv6 as well as ipv4, create a AAAA as well as an A record.  set the record to 'enable entry for dynamic dns', and set TTL to 5 minutes.
click the 'refresh' icon for each entry (column named DDNS), then 'generate a key'.  save the string for the $my4key and $my6key below.  I used the same name for ipv4 and ipv6

* configure port forwarding on your router for ipv4 and ipv6 port 443 internally
	forward 80 and 443 on ipv4, or else LetsEncrypt will not succeed

* tested on raspbian/stretch, last tried 2018-11 baseline
using default username 'pi', default password 'raspberry'

 sudo apt-get update && sudo apt-get upgrade -y
 reboot

* set up dynamic dns using he.net from above
add the output from running the following lines to pi user's crontab, using your $key and $hostname as appropriate:

 my4key=<generated key string for ipv4>
 my6key=<generated key string for ipv6>
 myhostname=<your-chosen-public-hostname>
 myemail=<your-username\\@your-email-server>
 
 cat | crontab - << EOF
 0 0 * * * curl -4 "https://$myhostname:$my4key@dyn.dns.he.net/nic/update?hostname=$myhostname"
 0 0 * * * curl -6 "https://$myhostname:$my6key@dyn.dns.he.net/nic/update?hostname=$myhostname"
 EOF

# install docker and docker-compose (18.06.1 for rpi zero)
 curl -fsSL get.docker.com | sudo sh
 sudo usermod -aG docker $USER
 newgrp docker
 curl -sL https://deb.nodesource.com/setup_11.x | sudo -E bash -
 sudo apt-get install -y python-pip git nodejs python-setuptools
 sudo pip install docker-compose

# clone project
 git clone https://github.com/rhbroberg/pool-controller.git

# swizzle variables and start service
 cd pool-controller/docker
 perl -pi -e "s/POOL_VIRTUAL_HOST=.*/POOL_VIRTUAL_HOST=$myhostname/g; s/POOL_LETSENCRYPT_HOST=.*/POOL_LETSENCRYPT_HOST=$myhostname/g; s/POOL_LETSENCRYPT_EMAIL=.*/POOL_LETSENCRYPT_EMAIL=$myemail/g" .env
 docker-compose up -d

