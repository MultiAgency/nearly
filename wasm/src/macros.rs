//! Request-level validation macros: extract required fields or return early with an error response.

#[macro_export]
macro_rules! require_caller {
    ($req:expr) => {
        match $crate::auth::get_caller_from($req) {
            Ok(c) => c,
            Err(e) => return e,
        }
    };
}

#[macro_export]
macro_rules! require_field {
    ($opt:expr, $msg:expr) => {
        match $opt {
            Some(v) => v,
            None => return err_coded("VALIDATION_ERROR", $msg),
        }
    };
}

#[macro_export]
macro_rules! require_timestamp {
    () => {
        match now_secs() {
            Ok(t) => t,
            Err(e) => return e.into(),
        }
    };
}
