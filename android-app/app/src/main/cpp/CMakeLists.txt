cmake_minimum_required(VERSION 3.22.1)

project("luker_android")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(
        native-lib
        SHARED
        native-lib.cpp)

target_compile_features(native-lib PRIVATE cxx_std_20)

target_include_directories(
        native-lib
        PRIVATE
        ${CMAKE_SOURCE_DIR}/../../../libnode/include/node)

add_library(
        node
        SHARED
        IMPORTED)

set_target_properties(
        node
        PROPERTIES
        IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(
        native-lib
        c++_shared
        node
        ${log-lib})
