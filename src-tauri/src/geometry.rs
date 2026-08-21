//! `--geometry` — a launch-time window size and position, and the remembered
//! geometry the same machinery restores on an ordinary launch.
//!
//! This exists for repeatable desktop walks, not for users. A macOS `.app`
//! launched from Finder or `open -a` receives no argv at all, so the flag only
//! reaches Nox when the executable is run directly (which is how the walk
//! harness starts it) or via `open --args`. Documented in
//! `.claude/skills/nox-desktop-walk`, deliberately not in the README.
//!
//! Everything here is pure so it can be tested without a window, a monitor or
//! a Tauri context — the parts that need those live in `lib.rs`.

/// A parsed `--geometry` value, in **logical points**.
///
/// Points, never physical pixels: on a Retina display the two differ by the
/// scale factor, and a walk that mixes them measures every position wrong.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geometry {
    pub width: f64,
    pub height: f64,
    /// Top-left corner. `None` leaves the window wherever Tauri put it, which
    /// with `"center": true` in tauri.conf.json means centred.
    pub position: Option<(f64, f64)>,
}

/// Parse `WxH` or `WxH+X+Y`, following the X11 geometry convention.
///
/// Deliberately strict. A silently-misparsed geometry produces a window of the
/// wrong size, and every observation made in it is then wrong in a way that
/// looks like an app bug rather than a harness bug — which has already cost
/// this project one retracted finding.
pub fn parse_geometry(value: &str) -> Result<Geometry, String> {
    let (size, offset) = match value.find('+') {
        Some(index) => (&value[..index], Some(&value[index..])),
        None => (value, None),
    };

    let (width, height) = size
        .split_once(['x', 'X'])
        .ok_or_else(|| format!("expected WxH, got {value:?}"))?;
    let width = parse_dimension(width, "width")?;
    let height = parse_dimension(height, "height")?;

    let position = match offset {
        None => None,
        Some(offset) => {
            // `+X+Y`: splitting on '+' yields a leading empty segment.
            let parts: Vec<&str> = offset.split('+').skip(1).collect();
            let [x, y] = parts.as_slice() else {
                return Err(format!("expected +X+Y, got {offset:?}"));
            };
            Some((parse_dimension(x, "x")?, parse_dimension(y, "y")?))
        }
    };

    Ok(Geometry { width, height, position })
}

fn parse_dimension(raw: &str, field: &str) -> Result<f64, String> {
    let value: f64 = raw
        .parse()
        .map_err(|_| format!("{field} is not a number: {raw:?}"))?;
    if !value.is_finite() {
        return Err(format!("{field} is not finite: {raw:?}"));
    }
    if value < 0.0 {
        return Err(format!("{field} must not be negative: {raw:?}"));
    }
    Ok(value)
}

/// Pull a `--geometry` value out of an argument list.
///
/// Accepts both `--geometry WxH` and `--geometry=WxH`. Returns `None` when the
/// flag is absent, and `Some(Err(_))` when it is present but unusable — the
/// caller must not treat a malformed flag as "no flag", because silently
/// ignoring it is how a walk ends up measuring a default-sized window while
/// believing it asked for something else.
pub fn geometry_from_args<I>(args: I) -> Option<Result<Geometry, String>>
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--geometry=") {
            return Some(parse_geometry(value));
        }
        if arg == "--geometry" {
            return Some(match args.next() {
                Some(value) => parse_geometry(&value),
                None => Err("--geometry needs a value, e.g. --geometry 1500x900+0+26".to_string()),
            });
        }
    }
    None
}

/// Fit a geometry inside the usable screen area and the window's own minimums.
///
/// A window taller than the display does not fail loudly — it just puts its
/// bottom rows past the screen edge, where a screenshot cannot see them. That
/// reads exactly like a missing status bar, and this project has already spent
/// a walk chasing that ghost. Clamping here means a bad `--geometry` produces a
/// smaller window rather than an invisible defect.
///
/// `visible` should be the monitor's work area (screen minus menu bar and
/// dock), not its full size, for the same reason.
pub fn clamp(geometry: Geometry, visible: (f64, f64), minimum: (f64, f64)) -> Geometry {
    let (visible_width, visible_height) = visible;
    let (min_width, min_height) = minimum;

    // The minimum wins over the visible area: a display smaller than the
    // window's own minimum is not something we can honour, and shrinking below
    // it would produce a layout that cannot occur on a real user's machine.
    let width = geometry.width.clamp(min_width, visible_width.max(min_width));
    let height = geometry.height.clamp(min_height, visible_height.max(min_height));

    let position = geometry.position.map(|(x, y)| {
        (
            x.clamp(0.0, (visible_width - width).max(0.0)),
            y.clamp(0.0, (visible_height - height).max(0.0)),
        )
    });

    Geometry { width, height, position }
}

/// The remembered window, as it sits in `window.json`.
///
/// Coordinates are **work-area-relative logical points**, the same space
/// `--geometry` uses and the same space [`clamp`] fits things into. Absolute
/// screen coordinates were the obvious alternative and are worse: they only
/// mean anything on the display they were recorded on, so a window remembered
/// on a monitor that is no longer attached would restore to a position with no
/// screen under it. Relative coordinates degrade to "the same place on
/// whatever display Nox opens on", which is the behaviour you want.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SavedWindow {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
}

/// Read `window.json`. `None` for anything unusable, which is not an error:
/// the file is a convenience, and a corrupt one must fall back to the
/// configured default rather than opening a 0x0 window nobody can grab.
///
/// A finite but out-of-range position is deliberately *accepted* here and left
/// to [`clamp`], which is the one place that knows what "on screen" means.
pub fn parse_saved(raw: &str) -> Option<Geometry> {
    let saved: SavedWindow = serde_json::from_str(raw).ok()?;
    if ![saved.width, saved.height, saved.x, saved.y]
        .iter()
        .all(|value| value.is_finite())
    {
        return None;
    }
    if saved.width <= 0.0 || saved.height <= 0.0 {
        return None;
    }
    Some(Geometry {
        width: saved.width,
        height: saved.height,
        position: Some((saved.x, saved.y)),
    })
}

/// Render a geometry for `window.json`. `None` when there is no position to
/// record — a size with no place to put it would restore as a centred window
/// of the right size, which is a different thing from what was remembered.
pub fn serialise_saved(geometry: Geometry) -> Option<String> {
    let (x, y) = geometry.position?;
    serde_json::to_string(&SavedWindow {
        width: geometry.width,
        height: geometry.height,
        x,
        y,
    })
    .ok()
}

/// Whether a window in this state is worth remembering.
///
/// A fullscreen or maximised window reports the size of the display, and
/// storing that as *the* remembered size is how an editor ends up opening
/// full-screen-sized-but-not-fullscreen forever after one ⌃⌘F. The last
/// ordinary size stays on file instead.
pub fn is_persistable(fullscreen: bool, maximized: bool) -> bool {
    !fullscreen && !maximized
}

/// What a launch should do about window geometry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Launch {
    /// `--geometry` was given and parsed. It wins over anything remembered,
    /// and this launch records nothing: the flag is a walk affordance (see the
    /// module doc), and letting a harness-sized window overwrite the user's
    /// remembered one would make running a walk destructive.
    Flag(Geometry),
    /// An ordinary launch: apply whatever was remembered, if anything, and
    /// keep the file up to date from here on.
    Remembered(Option<Geometry>),
}

/// Decide between the flag and the remembered geometry, and say what to warn
/// about. Separated from `lib.rs` so the precedence is testable without a
/// window — it is the rule most likely to be got wrong by a later edit.
///
/// A malformed flag falls through to `Remembered`: it did not take effect, so
/// this is an ordinary launch. It is still warned about, loudly, because a
/// walk that believes it asked for a size it did not get measures everything
/// against the wrong window.
pub fn decide_launch(
    flag: Option<Result<Geometry, String>>,
    remembered: Option<Geometry>,
) -> (Launch, Option<String>) {
    match flag {
        Some(Ok(requested)) => (Launch::Flag(requested), None),
        Some(Err(message)) => (Launch::Remembered(remembered), Some(message)),
        None => (Launch::Remembered(remembered), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (f64, f64) = (640.0, 420.0);

    #[test]
    fn parses_size_only() {
        assert_eq!(
            parse_geometry("1500x900"),
            Ok(Geometry { width: 1500.0, height: 900.0, position: None })
        );
    }

    #[test]
    fn parses_size_and_position() {
        assert_eq!(
            parse_geometry("1500x900+0+26"),
            Ok(Geometry { width: 1500.0, height: 900.0, position: Some((0.0, 26.0)) })
        );
    }

    /// Guards the strictness the module doc argues for: every one of these
    /// would otherwise land as a plausible-looking wrong window.
    #[test]
    fn rejects_malformed_values() {
        for bad in ["", "1500", "1500x", "x900", "1500*900", "1500x900+0", "1500x900+0+26+4", "axb", "-10x900"] {
            assert!(parse_geometry(bad).is_err(), "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn reads_both_flag_spellings() {
        let split = vec!["nox".to_string(), "--geometry".to_string(), "800x600".to_string()];
        let joined = vec!["nox".to_string(), "--geometry=800x600".to_string()];
        let expected = Geometry { width: 800.0, height: 600.0, position: None };
        assert_eq!(geometry_from_args(split), Some(Ok(expected)));
        assert_eq!(geometry_from_args(joined), Some(Ok(expected)));
    }

    #[test]
    fn absent_flag_is_none_but_broken_flag_is_an_error() {
        assert_eq!(geometry_from_args(vec!["nox".to_string()]), None);
        assert!(geometry_from_args(vec!["nox".to_string(), "--geometry".to_string()])
            .expect("flag was present")
            .is_err());
    }

    /// The regression this whole module exists to prevent: a window taller
    /// than the display hides its own bottom rows, which reads as a missing
    /// status bar rather than as bad input.
    #[test]
    fn clamps_a_window_larger_than_the_screen() {
        let asked = Geometry { width: 4000.0, height: 3000.0, position: None };
        let fitted = clamp(asked, (1512.0, 950.0), MIN);
        assert_eq!(fitted.width, 1512.0);
        assert_eq!(fitted.height, 950.0);
    }

    #[test]
    fn clamps_up_to_the_window_minimums() {
        let asked = Geometry { width: 100.0, height: 50.0, position: None };
        let fitted = clamp(asked, (1512.0, 950.0), MIN);
        assert_eq!((fitted.width, fitted.height), MIN);
    }

    #[test]
    fn keeps_the_whole_window_on_screen() {
        let asked = Geometry { width: 1000.0, height: 800.0, position: Some((1400.0, 900.0)) };
        let fitted = clamp(asked, (1512.0, 950.0), MIN);
        assert_eq!(fitted.position, Some((512.0, 150.0)));
    }

    /// A display smaller than the minimum cannot be honoured; the minimum must
    /// still win, so the walk never renders a layout no user could produce.
    #[test]
    fn minimum_beats_a_tiny_display() {
        let asked = Geometry { width: 700.0, height: 500.0, position: Some((10.0, 10.0)) };
        let fitted = clamp(asked, (320.0, 200.0), MIN);
        assert_eq!((fitted.width, fitted.height), MIN);
        assert_eq!(fitted.position, Some((0.0, 0.0)));
    }

    #[test]
    fn remembers_a_window_across_a_round_trip() {
        let remembered = Geometry { width: 1200.0, height: 700.0, position: Some((40.0, 26.0)) };
        let raw = serialise_saved(remembered).expect("a positioned geometry serialises");
        assert_eq!(parse_saved(&raw), Some(remembered));
    }

    /// The failure this prevents: trusting the file. It is hand-editable, it
    /// can be truncated by a crash mid-write, and every one of these would
    /// otherwise become a window the user cannot see or cannot grab.
    #[test]
    fn refuses_a_remembered_window_it_cannot_use() {
        for bad in [
            "",
            "null",
            "{}",
            r#"{"width":1200,"height":700}"#,
            r#"{"width":0,"height":700,"x":0,"y":0}"#,
            r#"{"width":-1200,"height":700,"x":0,"y":0}"#,
            r#"{"width":1200,"height":0,"x":0,"y":0}"#,
            r#"{"width":"wide","height":700,"x":0,"y":0}"#,
        ] {
            assert_eq!(parse_saved(bad), None, "expected {bad:?} to be refused");
        }
    }

    /// A position far off the remembered display is *not* a parse failure —
    /// the monitor it referred to may simply be unplugged. It is `clamp`'s
    /// job, and this is the case the requirement names: a window restored onto
    /// a display that is no longer there must not open off screen.
    #[test]
    fn a_window_remembered_on_a_detached_monitor_comes_back_on_screen() {
        let raw = r#"{"width":1200,"height":700,"x":2400,"y":1300}"#;
        let remembered = parse_saved(raw).expect("an off-screen position still parses");
        let fitted = clamp(remembered, (1512.0, 950.0), MIN);
        assert_eq!(fitted.position, Some((312.0, 250.0)));
        assert_eq!((fitted.width, fitted.height), (1200.0, 700.0));
    }

    /// A size with nowhere to be is not a remembered window. Writing one would
    /// restore as "the right size, centred", which is a different window.
    #[test]
    fn will_not_remember_a_size_with_no_position() {
        let sizeless = Geometry { width: 1200.0, height: 700.0, position: None };
        assert_eq!(serialise_saved(sizeless), None);
    }

    /// The requirement in one line: never store a fullscreen or maximised
    /// window as *the* size, or one ⌃⌘F makes every later launch screen-sized.
    #[test]
    fn refuses_to_remember_a_fullscreen_or_maximised_window() {
        assert!(is_persistable(false, false));
        assert!(!is_persistable(true, false));
        assert!(!is_persistable(false, true));
        assert!(!is_persistable(true, true));
    }

    /// The precedence the flag exists for. `--geometry` must beat whatever is
    /// remembered, or a walk measures the user's last window instead of the
    /// one it asked for.
    #[test]
    fn the_flag_beats_the_remembered_window_and_records_nothing() {
        let flag = Geometry { width: 1500.0, height: 900.0, position: Some((0.0, 26.0)) };
        let remembered = Geometry { width: 1200.0, height: 700.0, position: Some((40.0, 40.0)) };
        let (launch, warning) = decide_launch(Some(Ok(flag)), Some(remembered));
        assert_eq!(launch, Launch::Flag(flag));
        assert_eq!(warning, None);
    }

    #[test]
    fn an_ordinary_launch_restores_what_was_remembered() {
        let remembered = Geometry { width: 1200.0, height: 700.0, position: Some((40.0, 40.0)) };
        assert_eq!(
            decide_launch(None, Some(remembered)),
            (Launch::Remembered(Some(remembered)), None)
        );
        assert_eq!(decide_launch(None, None), (Launch::Remembered(None), None));
    }

    /// A flag that did not take effect leaves an ordinary launch behind — but
    /// it must still be said out loud, for the reason the module doc gives.
    #[test]
    fn a_malformed_flag_warns_and_falls_back_to_the_remembered_window() {
        let remembered = Geometry { width: 1200.0, height: 700.0, position: Some((40.0, 40.0)) };
        let (launch, warning) =
            decide_launch(Some(Err("expected WxH".to_string())), Some(remembered));
        assert_eq!(launch, Launch::Remembered(Some(remembered)));
        assert_eq!(warning.as_deref(), Some("expected WxH"));
    }
}
