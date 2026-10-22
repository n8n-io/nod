package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"syscall"
)

func main() {
	distribution := os.Getenv("NOD_WSL_DISTRIBUTION")
	if !regexp.MustCompile(`^nod-[a-f0-9]{12}$`).MatchString(distribution) {
		os.Exit(64)
	}
	system := os.Getenv("SYSTEMROOT")
	if !filepath.IsAbs(system) {
		os.Exit(64)
	}
	args := append([]string{"--distribution", distribution, "--user", "root", "--exec", "/usr/local/bin/nod-docker"}, os.Args[1:]...)
	command := exec.Command(filepath.Join(system, "System32", "wsl.exe"), args...)
	for _, key := range []string{"SYSTEMROOT", "USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP"} {
		if value := os.Getenv(key); value != "" {
			command.Env = append(command.Env, key+"="+value)
		}
	}
	if value := os.Getenv("POSTGRES_PASSWORD"); value != "" {
		command.Env = append(command.Env, "POSTGRES_PASSWORD="+value, "WSLENV=POSTGRES_PASSWORD")
	}
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if error := command.Run(); error != nil {
		if exit, ok := error.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		os.Exit(127)
	}
}
