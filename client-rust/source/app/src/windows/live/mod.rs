//! Authority-backed connected workflow windows.
//!
//! These views read only `WindowModel` and emit exact `ClientCommand` values;
//! unavailable context is rendered explicitly and never falls back to samples.
//!
//! Presentation is entirely the shared kit's. [`super::content`] resolves the
//! surface, draws the header and tab strip, and hands each function a [`Ctx`]
//! carrying the body rect and the active tab — so nothing here draws a title, a
//! tab, a frame, or a colour of its own. [`super::chrome`] paints every rule,
//! band, control, and meter at the density [`super::spec`] assigns the family.
//!
//! Two consequences worth knowing before editing:
//!   * **Lists are bounded by the rect, not by a magic count.** [`chrome::Rows`]
//!     stops emitting rows at the pane floor, so a frame dragged to its resize
//!     floor drops rows instead of drawing through the border.
//!   * **Only rasterized glyphs are used.** `hud::Icons` bakes ASCII 32..=126,
//!     so the `·`/`×`/`★`/`−` separators this file used to draw rendered as
//!     blank advances. Value columns replace them.

pub mod bank;
#[cfg(feature = "dev-tools")]
pub mod builder;
pub mod clone;
pub mod converse;
pub mod craft;
pub mod datapad;
pub mod examine;
pub mod loot;
pub mod macros;
pub mod social;
pub mod splice;
pub mod survey;
pub mod trade;
pub mod travel;
pub(crate) mod shared;

pub use shared::unavailable_window;
pub use bank::bank;
pub use bank::exchange;
pub use clone::clone_terminal;
pub use converse::converse;
pub use converse::converse_preview_rect;
pub use craft::craft;
pub use datapad::datapad;
pub use examine::examine;
pub use examine::examine_preview_rect;
pub use examine::examine_item_preview_rect;
pub use loot::loot;
pub use macros::macros_live;
pub use social::guild;
pub use social::group;
pub use splice::splice;
pub use survey::survey;
pub use survey::agriculture;
pub use trade::trade;
pub use travel::travel;
