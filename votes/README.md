# Votes

## US Senate and House Vote Data

## Prerequisites:

1. You need [dotenvx](https://dotenvx.com/docs/install) to manage secrets.
2. You need to have Docker running.

## Instructions:

1. Make sure Docker is running.
2. `dotenvx run -- docker compose up --build -d`
3. That's it.

## Deployment Notes:

I'm trying to fit this into a DO droplet with 1 GB memory, so I've tuned things
a bit.

### Droplet config

Need a swapfile because the RAM is so constrained. Here's how to set it up:

```
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' >> /etc/sysctl.conf
sysctl -p
```
