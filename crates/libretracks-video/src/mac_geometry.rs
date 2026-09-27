//! Where the macOS output panel goes, in Cocoa coordinates (paso 15, D6).
//!
//! The display picker lists Tauri's monitors. On macOS tao reports each one's
//! position and size in **physical pixels with the origin at the top-left of
//! the main display** (`CGDisplayBounds` times that display's scale). Cocoa
//! places windows in **points with the origin at the bottom-left of the main
//! display**. Pure, so it is tested on every platform.

use crate::monitors::SurfaceRect;

/// A rectangle in Cocoa points, origin bottom-left of the main display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CocoaRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One `NSScreen`: its `frame` and `backingScaleFactor`. The first screen of
/// the list is the main display (origin 0,0), as `+[NSScreen screens]` gives it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CocoaScreen {
    pub frame: CocoaRect,
    pub scale: f64,
}

impl CocoaScreen {
    /// This screen as tao reports it: physical pixels, top-left origin.
    fn physical_bounds(&self, main_height: f64) -> (f64, f64, f64, f64) {
        let top = main_height - (self.frame.y + self.frame.height);
        (
            self.frame.x * self.scale,
            top * self.scale,
            self.frame.width * self.scale,
            self.frame.height * self.scale,
        )
    }
}

/// The Cocoa frame for `rect` (tao coordinates) and the index of the screen
/// it lies on, or `None` without screens. Its scale converts pixels to points.
///
/// tao scales each display's position by **that display's** factor, so with
/// mixed scales the physical rectangles overlap: a 1x projector right of a 2x
/// laptop starts at x = 1440 px, inside the laptop's 0–2880. Among the screens
/// containing the rect's top-left corner, the one whose origin is closest to
/// it wins (exact for a fullscreen rect, which is the display's own bounds);
/// with none containing it, the nearest screen.
pub fn cocoa_frame_for(rect: &SurfaceRect, screens: &[CocoaScreen]) -> Option<(CocoaRect, usize)> {
    let main_height = screens.first()?.frame.height;
    let (px, py) = (f64::from(rect.x), f64::from(rect.y));
    // (outside distance², distance from the origin): lexicographic order.
    let score = |screen: &CocoaScreen| {
        let (x, y, w, h) = screen.physical_bounds(main_height);
        let dx = if px < x {
            x - px
        } else if px >= x + w {
            px - (x + w) + 1.0
        } else {
            0.0
        };
        let dy = if py < y {
            y - py
        } else if py >= y + h {
            py - (y + h) + 1.0
        } else {
            0.0
        };
        (dx * dx + dy * dy, (px - x).abs() + (py - y).abs())
    };
    let (index, screen) = screens.iter().enumerate().min_by(|a, b| {
        let (sa, sb) = (score(a.1), score(b.1));
        sa.0.total_cmp(&sb.0).then(sa.1.total_cmp(&sb.1))
    })?;
    let scale = if screen.scale > 0.0 {
        screen.scale
    } else {
        1.0
    };
    let width = f64::from(rect.width) / scale;
    let height = f64::from(rect.height) / scale;
    let top = py / scale;
    Some((
        CocoaRect {
            x: px / scale,
            y: main_height - (top + height),
            width,
            height,
        },
        index,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: f64, y: f64, width: f64, height: f64, scale: f64) -> CocoaScreen {
        CocoaScreen {
            frame: CocoaRect {
                x,
                y,
                width,
                height,
            },
            scale,
        }
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> SurfaceRect {
        SurfaceRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_projector_to_the_right_of_a_retina_laptop() {
        // Laptop 1440×900 pt at 2x (2880×1800 px), projector 1920×1080 at 1x
        // to its right, tops aligned. tao: laptop (0,0) 2880×1800, projector
        // (1440,0) 1920×1080 (its own scale, so 1440 pt → 1440 px).
        let screens = [
            screen(0.0, 0.0, 1440.0, 900.0, 2.0),
            screen(1440.0, -180.0, 1920.0, 1080.0, 1.0),
        ];
        let (frame, index) = cocoa_frame_for(&rect(1440, 0, 1920, 1080), &screens).unwrap();
        assert_eq!(index, 1);
        assert_eq!(
            frame,
            CocoaRect {
                x: 1440.0,
                y: -180.0,
                width: 1920.0,
                height: 1080.0
            }
        );

        let (frame, index) = cocoa_frame_for(&rect(0, 0, 2880, 1800), &screens).unwrap();
        assert_eq!(index, 0);
        assert_eq!(
            frame,
            CocoaRect {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0
            }
        );
    }

    #[test]
    fn a_display_above_the_main_one_has_negative_tao_y() {
        // A TV placed above the laptop: Cocoa y = 900 (above), tao y = -1080.
        let screens = [
            screen(0.0, 0.0, 1440.0, 900.0, 2.0),
            screen(0.0, 900.0, 1920.0, 1080.0, 1.0),
        ];
        let (frame, index) = cocoa_frame_for(&rect(0, -1080, 1920, 1080), &screens).unwrap();
        assert_eq!(index, 1);
        assert_eq!(
            frame,
            CocoaRect {
                x: 0.0,
                y: 900.0,
                width: 1920.0,
                height: 1080.0
            }
        );
    }

    #[test]
    fn a_window_inside_a_retina_display_keeps_its_size_in_points() {
        // Window mode on the laptop: 1280×720 px at (200, 100) px.
        let screens = [screen(0.0, 0.0, 1440.0, 900.0, 2.0)];
        let (frame, _) = cocoa_frame_for(&rect(200, 100, 1280, 720), &screens).unwrap();
        assert_eq!(
            frame,
            CocoaRect {
                x: 100.0,
                y: 900.0 - (50.0 + 360.0),
                width: 640.0,
                height: 360.0
            }
        );
    }

    #[test]
    fn a_window_on_the_1x_projector_is_not_taken_for_the_retina_laptop() {
        // Window mode inside the projector: (1500, 100) px is also inside the
        // laptop's overlapping 0–2880 px range; the closer origin decides.
        let screens = [
            screen(0.0, 0.0, 1440.0, 900.0, 2.0),
            screen(1440.0, -180.0, 1920.0, 1080.0, 1.0),
        ];
        let (frame, index) = cocoa_frame_for(&rect(1500, 100, 800, 600), &screens).unwrap();
        assert_eq!(index, 1);
        assert_eq!(frame.width, 800.0);
    }

    #[test]
    fn two_identical_monitors_are_told_apart_by_position() {
        let screens = [
            screen(0.0, 0.0, 1920.0, 1080.0, 1.0),
            screen(1920.0, 0.0, 1920.0, 1080.0, 1.0),
            screen(3840.0, 0.0, 1920.0, 1080.0, 1.0),
        ];
        assert_eq!(
            cocoa_frame_for(&rect(3840, 0, 1920, 1080), &screens)
                .unwrap()
                .1,
            2
        );
        assert_eq!(
            cocoa_frame_for(&rect(1920, 0, 1920, 1080), &screens)
                .unwrap()
                .1,
            1
        );
    }

    #[test]
    fn a_rect_off_every_screen_goes_to_the_nearest_and_none_without_screens() {
        let screens = [
            screen(0.0, 0.0, 1920.0, 1080.0, 1.0),
            screen(1920.0, 0.0, 1920.0, 1080.0, 1.0),
        ];
        assert_eq!(
            cocoa_frame_for(&rect(5000, 10, 800, 600), &screens)
                .unwrap()
                .1,
            1
        );
        assert!(cocoa_frame_for(&rect(0, 0, 10, 10), &[]).is_none());
    }
}
