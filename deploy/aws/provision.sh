#!/usr/bin/env bash
# Create the one instance Countersign runs on: key pair, security group,
# Amazon Linux 2023 t3.micro with bootstrap-instance.sh as user-data, and an
# Elastic IP. Prints the ssh target and the sslip.io public hostname.
#
#   AWS_REGION=ap-south-1 deploy/aws/provision.sh
#
# Re-runnable: an existing key pair or security group of the same name is
# reused, not duplicated. Needs the AWS CLI configured with a user allowed to
# manage EC2 in the region.
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
NAME="${NAME:-countersign}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.micro}"
KEY_FILE="${KEY_FILE:-$HOME/.ssh/countersign-aws.pem}"
HERE="$(cd "$(dirname "$0")" && pwd)"

aws() { command aws --region "$REGION" --output text "$@"; }

echo "→ account $(aws sts get-caller-identity --query Account) in $REGION"

# Key pair: created once, private half kept locally with ssh's permissions.
if ! aws ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1; then
  install -d -m 700 "$(dirname "$KEY_FILE")"
  aws ec2 create-key-pair --key-name "$NAME" --key-type ed25519 \
    --query KeyMaterial > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "→ key pair $NAME created, private key at $KEY_FILE"
else
  echo "→ key pair $NAME exists (private key expected at $KEY_FILE)"
fi

VPC_ID="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId')"
MY_IP="$(curl -fsS https://checkip.amazonaws.com)"

SG_ID="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-web" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' 2>/dev/null || true)"
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  SG_ID="$(aws ec2 create-security-group --group-name "$NAME-web" \
    --description "Countersign: HTTPS to the world, ssh from one address" --vpc-id "$VPC_ID" \
    --query GroupId)"
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$MY_IP/32" >/dev/null
  echo "→ security group $SG_ID created (22 only from $MY_IP)"
else
  echo "→ security group $SG_ID exists"
fi

AMI="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value)"

INSTANCE_ID="$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
  --key-name "$NAME" --security-group-ids "$SG_ID" \
  --user-data "file://$HERE/bootstrap-instance.sh" \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=16,VolumeType=gp3}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId')"
echo "→ instance $INSTANCE_ID launching ($INSTANCE_TYPE, $AMI)"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

ALLOC_ID="$(aws ec2 allocate-address --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId)"
aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null
IP="$(aws ec2 describe-addresses --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp')"

echo
echo "instance:    $INSTANCE_ID"
echo "ssh:         ec2-user@$IP   (key $KEY_FILE)"
echo "public host: ${IP//./-}.sslip.io"
echo
echo "The bootstrap takes a minute or two; wait for /opt/countersign/.bootstrapped before deploying."
