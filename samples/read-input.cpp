// A sample for "Run C++ and C Code". Click Run (top right) and type your name and two numbers.
// Or open the Input & Tests panel, paste the input, and save it as a test case.
#include <iostream>
#include <string>

int main() {
    std::string name;
    std::cout << "Your name: " << std::flush;
    std::getline(std::cin, name);
    long long a = 0, b = 0;
    std::cout << "Two numbers: " << std::flush;
    std::cin >> a >> b;
    std::cout << "Hello, " << name << "! " << a << " + " << b << " = " << a + b << "\n";
    return 0;
}
