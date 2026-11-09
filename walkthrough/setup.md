## Compiler setup

The extension uses the compiler on your computer and never downloads one.

- On macOS, run `xcode-select --install` in Terminal.
- On Windows, install MSYS2 (msys2.org) and run `pacman -S --needed mingw-w64-ucrt-x86_64-gcc` in the UCRT64 terminal, or install WinLibs. The extension also looks in `C:\msys64\ucrt64\bin`, `C:\msys64\mingw64\bin`, `C:\MinGW\bin` and the WinLibs folder, so PATH changes are optional.
- On Linux, run `sudo apt install build-essential` (Debian, Ubuntu), `sudo dnf install gcc gcc-c++` (Fedora), `sudo pacman -S base-devel` (Arch).

To pick a compiler (for example clang++ instead of g++, or g++-14), run Run C++: Pick Compiler.
