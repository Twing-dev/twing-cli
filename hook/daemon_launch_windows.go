//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// Windows equivalent of daemon_launch_unix.go's detachProcess: CREATE_NEW_
// PROCESS_GROUP (0x00000200) + DETACHED_PROCESS (0x00000008) -- raw values
// rather than named syscall constants, since DETACHED_PROCESS isn't
// exposed by the standard library's syscall package on this platform (only
// golang.org/x/sys/windows has it, and this module has exactly one
// dependency already -- gopkg.in/yaml.v3 -- deliberately not adding a
// second just for two well-known flag values).
func detachProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x00000008}
}
