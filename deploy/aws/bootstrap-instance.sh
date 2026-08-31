#!/usr/bin/env bash
# EC2 user-data for Amazon Linux 2023: Docker + the compose plugin, a deploy
# directory, and nothing else. Runs once, as root, at first boot.
set -euo pipefail

dnf -y update
dnf -y install docker
systemctl enable --now docker
usermod -aG docker ec2-user

# The compose plugin is not packaged for AL2023; install the static binary and
# verify it against the checksum Docker publishes beside the release, so a
# tampered mirror or a MITM cannot slip a different binary onto the box.
COMPOSE_VERSION="v2.29.7"
ARCH="$(uname -m)"
BASE="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "${BASE}/docker-compose-linux-${ARCH}" -o /tmp/docker-compose
curl -fsSL "${BASE}/docker-compose-linux-${ARCH}.sha256" -o /tmp/docker-compose.sha256
# The .sha256 file is "<hash>  docker-compose-linux-<arch>"; check the hash only.
echo "$(cut -d' ' -f1 /tmp/docker-compose.sha256)  /tmp/docker-compose" | sha256sum -c -
install -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
rm -f /tmp/docker-compose /tmp/docker-compose.sha256

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
