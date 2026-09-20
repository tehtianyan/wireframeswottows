// devserver runs the API against a named env file.
//
//	go run ./cmd/devserver -env .env.dev -port 3001
//
// Why this exists: `vercel dev` loads .env, which points at production. The
// methodology work runs against a separate development project, and swapping
// .env back and forth is exactly the kind of thing that eventually gets left
// swapped. This keeps the two environments addressable at the same time —
// production stays in .env, development in .env.dev, and neither file moves.
//
// It serves only /api/v1; the front end still comes from `vercel dev` or
// `vite dev`. The test suites talk to the API alone, so this is all they need.
//
// Vercel never builds this: vercel.json rewrites /api/v1/* to api/index, and
// the Go builder compiles that entrypoint. Keep it that way — this binary
// must never become the deployment path.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"swot-tows/pkg/router"
)

func main() {
	envFile := flag.String("env", ".env.dev", "env file to load into the process environment")
	port := flag.String("port", "3001", "port to listen on")
	flag.Parse()

	loaded, err := loadEnv(*envFile)
	if err != nil {
		log.Fatalf("reading %s: %v", *envFile, err)
	}

	target := os.Getenv("SUPABASE_URL")
	if target == "" {
		log.Fatalf("%s set no SUPABASE_URL — the API cannot verify a token without it", *envFile)
	}

	fmt.Printf("devserver: %d variables from %s\n", loaded, *envFile)
	fmt.Printf("devserver: talking to %s\n", target)
	if os.Getenv("ANTHROPIC_API_KEY") == "" {
		fmt.Println("devserver: no ANTHROPIC_API_KEY — the AI panel will hide itself and no paid calls can happen")
	}
	fmt.Printf("devserver: listening on http://localhost:%s/api/v1/health\n", *port)

	srv := &http.Server{
		Addr:              ":" + *port,
		Handler:           devCORS(router.New()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}

// devCORS lets the Vite dev server on another port call this one.
//
// It reflects the request's Origin, which is deliberately permissive and
// deliberately confined to this binary: the deployed API is same-origin behind
// vercel.json's rewrite and has no CORS handling at all. If this ever becomes
// the deployment path, this function is a hole — which is why the package
// comment says it must not.
func devCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// loadEnv parses a dotenv file and sets each variable, overwriting whatever is
// already in the environment. Overwriting is deliberate: the point of naming a
// file is that the file wins.
func loadEnv(file string) (int, error) {
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
