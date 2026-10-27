// Package envfile loads a named dotenv file into the process environment.
//
// It exists because the project runs TWO databases and every command-line tool
// has to be able to say which one it means — .env is production, .env.dev is
// development, and a tool that can only read whichever one is called .env is a
// tool that eventually runs against the wrong database.
//
// Shared by cmd/devserver and cmd/grantadmin so the two cannot disagree about
// what a dotenv line means.
package envfile

import (
	"os"
	"path/filepath"
	"strings"
)

// Load parses a dotenv file and sets each variable, overwriting whatever is
// already in the environment, and returns how many it set. Overwriting is
// deliberate: the point of naming a file is that the file wins.
func Load(file string) (int, error) {
	raw, err := os.ReadFile(filepath.Clean(file))
	if err != nil {
		return 0, err
	}
	n := 0
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:i])
		val := strings.TrimSpace(line[i+1:])
		val = strings.Trim(val, `"'`)
		if err := os.Setenv(key, val); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}
