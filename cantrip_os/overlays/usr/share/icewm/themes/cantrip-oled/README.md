# Cantrip OLED

A monochrome adaptation of `Icewm_Nord_style_small` by IamJony, supplied in the
owner's ThemePrep download. Original attribution: `IamJony | www.github/IamJony`.
The supplied GPL version 2 license is preserved in `COPYING`.

Modified 2026-11-03: black surfaces, neutral text/selections, monochrome XPM
palettes, DejaVu Sans text, no wallpaper, and corrected `restoreO.xpm` naming.
The supplied font is a text font, not an icon dependency, and is not included.
Unused alternates and the oversized optional application-icon pack are omitted;
application icons fall back to the installed system icons.

Edit `default.theme` for colors, fonts, and sizing. Edit the text palettes at
the top of the XPM files for window controls, title strips, and taskbar images.
These files are the source of truth, installed unchanged in Docker and ISOs.
The system default is `/etc/X11/icewm/theme`; desktop background overrides live
in `/etc/X11/icewm/prefoverride`. Personal `~/.icewm` overrides still take priority.

The `frame*.xpm` and `dframe*.xpm` files add a complete one-pixel neutral outline
on every edge, with black padding for a four-pixel resize target. Keep their
sizes aligned with `BorderSizeX/Y` and `DlgBorderSizeX/Y` in `default.theme`.
