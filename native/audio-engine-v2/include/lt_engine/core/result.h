#pragma once

#include <optional>
#include <string>
#include <variant>

namespace lt {

// Lightweight result type used throughout the engine.
// Use Result<T> for fallible operations, Result<void> for procedures.
template <typename T>
struct Result {
    std::variant<T, std::string> value;

    static Result ok(T v)               { return Result{std::variant<T,std::string>{std::in_place_index<0>, std::move(v)}}; }
    static Result err(std::string msg)  { return Result{std::variant<T,std::string>{std::in_place_index<1>, std::move(msg)}}; }

    bool is_ok()  const { return value.index() == 0; }
    bool is_err() const { return value.index() == 1; }

    const T&           unwrap()      const { return std::get<0>(value); }
    T&&                take()              { return std::get<0>(std::move(value)); }
    const std::string& error()       const { return std::get<1>(value); }
};

template <>
struct Result<void> {
    std::optional<std::string> err_msg;

    static Result ok()                  { return Result{std::nullopt}; }
    static Result err(std::string msg)  { return Result{std::move(msg)}; }

    bool is_ok()  const { return !err_msg.has_value(); }
    bool is_err() const { return  err_msg.has_value(); }

    const std::string& error() const { return *err_msg; }
};

} // namespace lt
