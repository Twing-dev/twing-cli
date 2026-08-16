//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detachProcess puts the daemon in its own session (setsid) so it survives
// this hook process exiting -- same detachment property Node's
// spawn(..., {detached:true}) gives spawn-daemon.ts's own copy of this.
func detachProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
