tested on raspbian/stretch, last tried 2018-11 baseline
using default username 'pi', default password 'raspberry'

sudo apt-get update && sudo apt-get upgrade -y
reboot

curl -fsSL get.docker.com | sudo sh
sudo usermod -aG docker pi
newgrp docker

sudo apt-get install -y python-pip git
pip install docker-compose
git clone https://github.com/rhbroberg/pool-controller.git

cd pool-controller/docker && docker-compose up -d

