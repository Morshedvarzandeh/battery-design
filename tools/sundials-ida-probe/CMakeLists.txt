cmake_minimum_required(VERSION 3.18)

project(battery_design_sundials_ida_probe LANGUAGES C)

find_package(SUNDIALS 7.8.0 EXACT CONFIG REQUIRED COMPONENTS ida)

if(NOT TARGET SUNDIALS::ida)
  message(FATAL_ERROR "The exact SUNDIALS package does not export SUNDIALS::ida")
endif()

add_executable(sundials_ida_lifecycle_probe main.c)
set_target_properties(
  sundials_ida_lifecycle_probe
  PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED YES
    C_EXTENSIONS NO
)
target_link_libraries(sundials_ida_lifecycle_probe PRIVATE SUNDIALS::ida)

enable_testing()
add_test(
  NAME sundials_ida_lifecycle_probe
  COMMAND sundials_ida_lifecycle_probe
)
