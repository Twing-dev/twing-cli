# deploy/

Scripts for running `twing serve` on a shared machine under an isolated,
unprivileged user. All three are idempotent: safe to re-run, whether
that's fixing a mistake on the same box or setting up a second one.

## One-time setup

Run on the target machine, as a user with sudo (e.g. the cloud image's
default account):

```sh
sudo deploy/create-service-user.sh                # twingcli, keys from ubuntu
# or: sudo deploy/create-service-user.sh myuser sourceuser
```

Creates the service account (SSH-key-only, no password login at all),
mirrors SSH access from an existing account so nobody loses access, and
locks both home directories down to `700` so neither can browse the other's.
Prints a verification block at the end (group membership, sudo check, a
live attempt to read the source user's home) -- read it, don't just trust
that the script ran.

Then, **as the new user** (`ssh twingcli@<host>`):

```sh
git clone git@github.com:Twing-dev/twing-cli.git
cd twing-cli
npm install
npm run build
```

Back as the sudo-capable user:

```sh
sudo deploy/install-service.sh                     # or: sudo deploy/install-service.sh /home/twingcli/twing-cli twingcli 8787
```

Writes the systemd unit, grants the service user a narrowly scoped
passwordless sudo rule (only `systemctl {restart,start,stop,status}
twing-serve` -- nothing else, not general sudo), and starts the service.
Refuses to run if it can't find a build yet, rather than installing a unit
that would just crash-loop.

## Day to day: shipping a change

As the service user, from inside the repo:

```sh
deploy/redeploy.sh
```

Pulls, installs, rebuilds, restarts, prints status. The restart step uses
the scoped sudo grant from `install-service.sh` -- no privileged account
needed for routine redeploys.

## Logs

```sh
journalctl -u twing-serve -f
```

## Why the sudo grant is scoped the way it is

`ReadWritePaths=$REPO_DIR` in the unit carves an exception into
`ProtectHome=true`/`ProtectSystem=strict` so the service can read its own
build output -- everything else on the filesystem, including every other
user's home directory, stays inaccessible to the process regardless of
Unix file permissions, enforced by the kernel via mount namespaces. The
sudoers rule is similarly narrow: it names the exact four `systemctl`
invocations and nothing else, so the service user can manage its own unit
without ever gaining real root.
