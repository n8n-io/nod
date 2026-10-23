---
title: Choose a cloud server
description: Create a Linux server for nod on Google Cloud, AWS, or Oracle Cloud using a free trial or free tier.
sidebar:
  order: 3
---

Use a Linux virtual machine with Docker Engine and persistent disk storage. The same nod stack runs on each provider.

Start with two CPU cores, 8 GB of memory, and 50 GB of disk. This is a starting size, not a measured minimum. Parallel browser tasks need more memory. Running a model on the same machine needs separate capacity.

## Compare free offers

Offers checked on 2026-10-23. Eligibility, capacity, and terms can change. Verify the account's plan and remaining credit before creating a server.

| Provider     | Suggested test server                                                | Free offer                                                                                          | What happens when it ends                                        |
| ------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Google Cloud | `e2-standard-2`, Ubuntu 24.04, 50 GB persistent disk                 | Eligible new customers get US$300 for 90 days.                                                      | Resources stop unless you explicitly upgrade.                    |
| AWS          | `m7i-flex.large`, Ubuntu 24.04, 50 GB EBS                            | Eligible new customers get US$100, with up to US$100 more through activities. Choose **Free plan**. | The account closes after six months or when its credits run out. |
| Oracle Cloud | `VM.Standard.A1.Flex`, two OCPUs, 12 GB RAM, Ubuntu, 50 GB boot disk | Always Free allowance, subject to home-region capacity.                                             | No fixed expiry; idle instances can be reclaimed.                |

These are trial configurations, not a promise of unlimited free hosting. Model providers charge separately. Google Cloud's always-free `e2-micro` and the smallest free AWS instances have less memory than the starting size above.

## Google Cloud

1. Check [Free Trial eligibility](https://docs.cloud.google.com/free/docs/free-cloud-features). You must not have used the trial or previously paid for Google Cloud, Google Maps Platform, or Firebase.
2. Create a trial billing account and a project for nod. Keep the account on the trial plan. Google requires a valid payment method for verification.
3. Create a Compute Engine VM using Ubuntu 24.04 and [`e2-standard-2`](https://docs.cloud.google.com/compute/docs/general-purpose-machines#e2_machine_types), which has two vCPUs and 8 GB of memory. Attach a 50 GB persistent boot disk.
4. For public access, allow inbound TCP ports 80 and 443. Restrict SSH to your address or use the provider's SSH access.
5. Connect to the VM, [install Docker Engine and Compose](https://docs.docker.com/engine/install/ubuntu/), then follow [Host your own server](/deploy/self-host/).

The trial has limited quotas and cannot request quota increases. If a zone is full, try another zone within the available quota. Google documents these [quota limits](https://docs.cloud.google.com/compute/resource-usage).

## AWS

1. Review [AWS Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), then choose **Free plan** during signup. An existing paid account has different billing rules.
2. Launch an EC2 instance with Ubuntu 24.04 and [`m7i-flex.large`](https://aws.amazon.com/ec2/instance-types/m7i/), which has two vCPUs and 8 GiB of memory. Check that the image and instance show **Free tier eligible**.
3. Add a 50 GB EBS boot volume. Compute, disk, public addresses, and traffic can consume trial credit; monitor the account's remaining credit.
4. Create a security group allowing TCP 80 and 443 for public access, and SSH only from your address. Keep the database and Docker API closed.
5. Connect with SSH, [install Docker Engine and Compose](https://docs.docker.com/engine/install/ubuntu/), then follow [Host your own server](/deploy/self-host/).

The current [EC2 free-tier rules](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html) list `m7i-flex.large` as eligible for accounts created from 2025-07-15. An eligible label means credit can cover usage; it does not mean the VM runs indefinitely for free.

## Oracle Cloud

1. Review [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/faq/). Oracle permits one free account per person and requires a supported payment card for verification.
2. Choose your home region carefully. Always Free compute and disk must be created there.
3. Create an Ubuntu instance with `VM.Standard.A1.Flex`, two OCPUs, 12 GB RAM, and a 50 GB boot disk. Confirm the resources are **Always Free eligible**.
4. Allow inbound TCP 80 and 443 in the network security group or subnet rules. Restrict SSH to your address. Check the VM's own firewall too.
5. Connect with SSH, [install Docker Engine and Compose](https://docs.docker.com/engine/install/ubuntu/), then follow [Host your own server](/deploy/self-host/). This server uses ARM64.

The current [Always Free allowance](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) is 1,500 OCPU hours and 9,000 GB hours each month: two OCPUs and 12 GB continuously. Boot and block volumes share a 200 GB allowance. Older guides describing four OCPUs and 24 GB do not match the current documentation.

Oracle can reclaim instances that meet its idle criteria over seven days. Capacity is not guaranteed. If the free shape is unavailable, try another availability domain or another provider. Keep an independent [backup](/deploy/server-operations/#back-up).

## Finish the network setup

Point a domain's DNS record at the VM's public address and use HTTPS. Open only 80 and 443 for nod's proxy. Keep SSH restricted.

Docker warns that published container ports can bypass `ufw` rules. Use the provider firewall as well, and don't publish PostgreSQL, the browser, the workspace, or the Docker API. See [Docker's firewall limitations](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations).

Before a trial expires, export a backup and decide whether to move or keep the server. Stopping a VM can leave disks and addresses allocated. Follow the provider's removal flow when you finish a disposable test.

## Related resources

- [Deploy and operate](/deploy/)
- [Host your own server](/deploy/self-host/)
- [Back up and update a server](/deploy/server-operations/)
- [Host on a Mac mini](/deploy/mac-mini/)
