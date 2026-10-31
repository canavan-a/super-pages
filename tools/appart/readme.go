package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// writeReadme writes the one-line wordmark as SVGs for the README, one for
// light pages and one for dark (GitHub picks with <picture>), on a
// transparent background. Each run of same-colored sub-pixels in a row is one
// rect, so the file stays small.
func writeReadme(dir string, pals map[string]Palette, line Grid) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	const pw, ph = 3, 4
	for _, n := range []string{"light", "dark"} {
		p := pals[n]
		var b strings.Builder
		w, h := line.w()*pw, len(line)*ph
		fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" shape-rendering="crispEdges" role="img" aria-label="Super Pages">`+"\n", w*2, h*2, w, h)
		for y, row := range line {
			for x := 0; x < len(row); {
				c := row[x]
				if c == '.' {
					x++
					continue
				}
				end := x
				for end < len(row) && row[end] == c {
					end++
				}
				fmt.Fprintf(&b, `<rect x="%d" y="%d" width="%d" height="%d" fill="%s"/>`+"\n", x*pw, y*ph, (end-x)*pw, ph, toHex(p.color(legend[c])))
				x = end
			}
		}
		b.WriteString("</svg>\n")
		if err := os.WriteFile(filepath.Join(dir, "wordmark-"+n+".svg"), []byte(b.String()), 0o644); err != nil {
			return err
		}
	}
	return nil
}
