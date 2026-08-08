cmake_minimum_required(VERSION 3.22)

project(battery_design_sundials_ida_klu_probe LANGUAGES C)

set(CMAKE_FIND_USE_PACKAGE_REGISTRY OFF)
set(CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY OFF)

find_package(KLU 2.3.3 EXACT CONFIG REQUIRED)
find_package(
  SUNDIALS 7.8.0 EXACT CONFIG REQUIRED
  COMPONENTS ida nvecserial sunlinsolklu sunmatrixsparse
)

foreach(
  required_target
  SUNDIALS::ida
  SUNDIALS::nvecserial
  SUNDIALS::sunlinsolklu
  SUNDIALS::sunmatrixsparse
  SuiteSparse::KLU
)
  if(NOT TARGET ${required_target})
    message(FATAL_ERROR "The private prefixes do not export ${required_target}")
  endif()
endforeach()

add_executable(sundials_ida_klu_factor_probe main.c)
set_target_properties(
  sundials_ida_klu_factor_probe
  PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED YES
    C_EXTENSIONS NO
)
target_link_libraries(
  sundials_ida_klu_factor_probe
  PRIVATE
    SUNDIALS::ida
    SUNDIALS::nvecserial
    SUNDIALS::sunlinsolklu
    SUNDIALS::sunmatrixsparse
    SuiteSparse::KLU
)

enable_testing()
add_test(
  NAME sundials_ida_klu_factor_probe
  COMMAND sundials_ida_klu_factor_probe
)
