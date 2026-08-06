//! Natural alphanumeric sort for filenames (e.g. clip2 before clip10).
//! Behaviour port of legacy `natural_sort.py`.

use std::cmp::Ordering;
use std::path::Path;

/// Split `text` into alternating text/number parts for natural ordering.
/// Numbers compare as integers; text parts are lowercased (like Python).
pub fn natural_sort_key(text: &str) -> Vec<NaturalPart> {
    let mut key = Vec::new();
    let mut chars = text.chars().peekable();

    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            let mut num = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    num.push(d);
                    chars.next();
                } else {
                    break;
                }
            }
            // Leading zeros: parse as int (Python int("007") == 7)
            let n: u64 = num.parse().unwrap_or(0);
            key.push(NaturalPart::Number(n));
        } else {
            let mut s = String::new();
            while let Some(&ch) = chars.peek() {
                if ch.is_ascii_digit() {
                    break;
                }
                s.push(ch);
                chars.next();
            }
            key.push(NaturalPart::Text(s.to_lowercase()));
        }
    }

    key
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NaturalPart {
    Text(String),
    Number(u64),
}

impl PartialOrd for NaturalPart {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for NaturalPart {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (NaturalPart::Number(a), NaturalPart::Number(b)) => a.cmp(b),
            (NaturalPart::Text(a), NaturalPart::Text(b)) => a.cmp(b),
            // Heterogeneous: Python compares int vs str by type in Py3 — raises;
            // for sort stability we put numbers before text (common natural-sort convention).
            (NaturalPart::Number(_), NaturalPart::Text(_)) => Ordering::Less,
            (NaturalPart::Text(_), NaturalPart::Number(_)) => Ordering::Greater,
        }
    }
}

/// Sort paths by basename in natural order (legacy `sort_paths_by_basename`).
pub fn sort_paths_by_basename(paths: &[String]) -> Vec<String> {
    let mut sorted = paths.to_vec();
    sorted.sort_by(|a, b| {
        let name_a = Path::new(a)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(a.as_str());
        let name_b = Path::new(b)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(b.as_str());
        natural_sort_key(name_a).cmp(&natural_sort_key(name_b))
    });
    sorted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip2_before_clip10() {
        let mut names = vec!["clip10.mp4", "clip2.mp4", "clip1.mp4"];
        names.sort_by(|a, b| natural_sort_key(a).cmp(&natural_sort_key(b)));
        assert_eq!(names, vec!["clip1.mp4", "clip2.mp4", "clip10.mp4"]);
    }

    #[test]
    fn case_insensitive_text() {
        let a = natural_sort_key("B.mp4");
        let b = natural_sort_key("a.mp4");
        assert!(b < a);
    }

    #[test]
    fn sort_paths_by_basename_orders_naturally() {
        let paths = vec![
            r"C:\videos\clip10.mp4".into(),
            r"C:\videos\clip2.mp4".into(),
            r"C:\other\clip1.mp4".into(),
        ];
        let sorted = sort_paths_by_basename(&paths);
        assert_eq!(
            sorted,
            vec![
                r"C:\other\clip1.mp4",
                r"C:\videos\clip2.mp4",
                r"C:\videos\clip10.mp4",
            ]
        );
    }

    #[test]
    fn pure_numbers() {
        let mut names = vec!["10", "2", "1"];
        names.sort_by(|a, b| natural_sort_key(a).cmp(&natural_sort_key(b)));
        assert_eq!(names, vec!["1", "2", "10"]);
    }
}
