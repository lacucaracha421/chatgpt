const ICON_KEYS: [&str; 24] = [
    "folder",
    "photo",
    "film",
    "music",
    "book",
    "star",
    "heart",
    "user",
    "users",
    "academic-cap",
    "briefcase",
    "home",
    "globe",
    "map",
    "calendar",
    "clock",
    "bookmark",
    "tag",
    "sparkles",
    "bolt",
    "fire",
    "trophy",
    "puzzle",
    "cube",
];

const COLOR_KEYS: [&str; 12] = [
    "red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo",
    "purple", "pink",
];

pub(super) fn validate(icon_key: Option<&str>, color_key: Option<&str>) -> bool {
    icon_key.is_none_or(|key| ICON_KEYS.contains(&key))
        && color_key.is_none_or(|key| COLOR_KEYS.contains(&key))
}
