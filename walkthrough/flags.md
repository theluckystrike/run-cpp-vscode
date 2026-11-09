## Flags and arguments for one file

Put these comment lines in the first 40 lines of a file:

```c
// run: -O2 -lm
// args: "Hello World" 3
```

- `run:` adds compiler flags for this file only. They come after the flags from settings, so `-O2` wins over the default `-O0`. You can also list other source files here: `// run: util.c`.
- `args:` sets the program arguments. Quotes keep spaces together, so `argv[1]` is `Hello World`. No shell runs, so `*`, `$` and `;` are passed as they are.

The defaults are in Settings: `zovoRun.cppFlags` (`-std=c++20 -Wall -Wextra -g -O0`) and `zovoRun.cFlags` (`-std=c17 ...`).
