#!/usr/bin/env bash
# EC2 user-data for Amazon Linux 2023: Docker + the compose plugin, a deploy
# directory, and nothing else. Runs once, as root, at first boot.
set -euo pipefail

dnf -y update
dnf -y install docker
systemctl enable --now docker
usermod -aG docker ec2-user

# The compose plugin is not packaged for AL2023; install the static binary.
COMPOSE_VERSION="v2.29.7"
ARCH="$(uname -m)"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# 1 GB of swap: a t3.micro has 1 GB of RAM and Postgres plus Node fit, but
# without swap an image load can tip it over.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -o ec2-user -g ec2-user -m 750 /opt/countersign
touch /opt/countersign/.bootstrapped
