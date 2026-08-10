# deploy/

Scripts for running `twing serve` as a background process that survives
SSH logout, with logs you can actually get to. No sudo needed for any of
this -- run it entirely as whatever user you're SSH'd in as (e.g. an
isolated, unprivileged service user on a shared machine).

## Setup (once)

```sh
git clone git@github.com:Twing-dev/twing-cli.git
cd twing-cli
npm install
npm run build
```

## Start

```sh
deploy/start-server.sh              # port 8787
# or: deploy/start-server.sh . 9000  # a different port
```

Detaches from your shell (`nohup` + `disown`) so it keeps running after you
disconnect, writes a PID file (`twing-serve.pid`) for `stop-server.sh` to
find later, and refuses to start if it's already running or if there's no
build yet.

## Logs

```sh
tail -f twing-serve.log
```

Plain appended file, both stdout and stderr. Nothing rotates it
automatically -- if this runs for a long time, keep an eye on its size
(`logrotate` or just truncating it periodically both work fine).

## Stop

```sh
deploy/stop-server.sh
```

## Ship a change (pull, rebuild, restart)

```sh
deploy/redeploy.sh
```

Runs `git pull && npm install && npm run build`, then stop + start.

## If you want it to survive a reboot / auto-restart on crash

The scripts above are deliberately simple (no sudo, no systemd) for
day-to-day use. `install-service.sh` sets the same thing up as a proper
systemd service instead -- auto-restarts on crash, starts on boot,
`journalctl`-based logs, and a narrowly scoped sudo rule so redeploys still
don't need a privileged account. It needs to be run once by a sudo-capable
user (not the unprivileged one that runs the actual service):

```sh
sudo deploy/install-service.sh                     # defaults: this repo, user twingcli, port 8787
```

See the comments in that script for what it does; not required unless you
want reboot/crash resilience beyond what `start-server.sh` gives you.
