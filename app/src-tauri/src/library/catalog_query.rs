use rusqlite::types::Value;

const MAX_QUERY_BYTES: usize = 4_096;
const MAX_QUERY_TOKENS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SourceSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogQueryError {
    pub span: SourceSpan,
    pub message: String,
}

impl std::fmt::Display for CatalogQueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "검색식 {}..{} 위치: {}",
            self.span.start, self.span.end, self.message
        )
    }
}

impl std::error::Error for CatalogQueryError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Token {
    pub kind: TokenKind,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TokenKind {
    Word(String),
    Value(String),
    And,
    Or,
    Not,
    Minus,
    Colon,
    Greater,
    GreaterEqual,
    Less,
    LessEqual,
    LeftParen,
    RightParen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Comparison {
    Equal,
    Greater,
    GreaterEqual,
    Less,
    LessEqual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Expr {
    Title(String),
    Tag { namespace: String, value: String },
    Id(i64),
    Category(i64),
    Uploader(String),
    Pages(Comparison, i64),
    Not(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CompiledQuery {
    pub sql: String,
    pub params: Vec<Value>,
}

pub(crate) fn tokenize(source: &str) -> Result<Vec<Token>, CatalogQueryError> {
    if source.len() > MAX_QUERY_BYTES {
        return Err(error(
            MAX_QUERY_BYTES,
            source.len(),
            "검색식이 허용 길이를 초과했습니다",
        ));
    }
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < source.len() {
        let character = source[cursor..]
            .chars()
            .next()
            .expect("cursor is in bounds");
        if character.is_whitespace() {
            cursor += character.len_utf8();
            continue;
        }
        let start = cursor;
        let simple = match character {
            '(' => Some(TokenKind::LeftParen),
            ')' => Some(TokenKind::RightParen),
            ':' => Some(TokenKind::Colon),
            '-' => Some(TokenKind::Minus),
            '>' => {
                cursor += 1;
                if source[cursor..].starts_with('=') {
                    cursor += 1;
                    Some(TokenKind::GreaterEqual)
                } else {
                    Some(TokenKind::Greater)
                }
            }
            '<' => {
                cursor += 1;
                if source[cursor..].starts_with('=') {
                    cursor += 1;
                    Some(TokenKind::LessEqual)
                } else {
                    Some(TokenKind::Less)
                }
            }
            '=' => {
                return Err(error(
                    start,
                    start + 1,
                    "'=' 연산자는 단독으로 사용할 수 없습니다",
                ));
            }
            '"' => {
                cursor += 1;
                let mut value = String::new();
                let mut closed = false;
                while cursor < source.len() {
                    let next = source[cursor..]
                        .chars()
                        .next()
                        .expect("cursor is in bounds");
                    if next == '"' {
                        cursor += 1;
                        closed = true;
                        break;
                    }
                    if next == '\\' {
                        let escape_start = cursor;
                        cursor += 1;
                        let Some(escaped) = source[cursor..].chars().next() else {
                            return Err(error(
                                start,
                                source.len(),
                                "인용 문자열이 닫히지 않았습니다",
                            ));
                        };
                        match escaped {
                            '"' | '\\' => value.push(escaped),
                            _ => {
                                return Err(error(
                                    escape_start,
                                    cursor + escaped.len_utf8(),
                                    "인용 문자열에서는 따옴표와 역슬래시만 이스케이프할 수 있습니다",
                                ));
                            }
                        }
                        cursor += escaped.len_utf8();
                    } else {
                        value.push(next);
                        cursor += next.len_utf8();
                    }
                }
                if !closed {
                    return Err(error(
                        start,
                        source.len(),
                        "인용 문자열이 닫히지 않았습니다",
                    ));
                }
                if value.is_empty() {
                    return Err(error(start, cursor, "빈 인용 문자열은 검색할 수 없습니다"));
                }
                tokens.push(Token {
                    kind: TokenKind::Value(value),
                    span: SourceSpan { start, end: cursor },
                });
                continue;
            }
            _ => None,
        };
        if let Some(kind) = simple {
            if !matches!(character, '>' | '<') {
                cursor += character.len_utf8();
            }
            tokens.push(Token {
                kind,
                span: SourceSpan { start, end: cursor },
            });
            continue;
        }

        while cursor < source.len() {
            let next = source[cursor..]
                .chars()
                .next()
                .expect("cursor is in bounds");
            if next.is_whitespace() || matches!(next, '(' | ')' | ':' | '"' | '>' | '<' | '=') {
                break;
            }
            cursor += next.len_utf8();
        }
        if cursor == start {
            return Err(error(
                start,
                start + character.len_utf8(),
                "지원하지 않는 문자입니다",
            ));
        }
        let word = &source[start..cursor];
        let kind = if word.eq_ignore_ascii_case("AND") {
            TokenKind::And
        } else if word.eq_ignore_ascii_case("OR") {
            TokenKind::Or
        } else if word.eq_ignore_ascii_case("NOT") {
            TokenKind::Not
        } else {
            TokenKind::Word(word.to_owned())
        };
        tokens.push(Token {
            kind,
            span: SourceSpan { start, end: cursor },
        });
    }
    if tokens.len() > MAX_QUERY_TOKENS {
        return Err(error(0, source.len(), "검색 조건이 너무 많습니다"));
    }
    Ok(tokens)
}

pub(crate) fn parse(source: &str) -> Result<Option<Expr>, CatalogQueryError> {
    let tokens = tokenize(source)?;
    if tokens.is_empty() {
        return Ok(None);
    }
    let mut parser = Parser {
        source_len: source.len(),
        tokens,
        cursor: 0,
    };
    let expression = parser.parse_or()?;
    if let Some(token) = parser.peek() {
        return Err(error(
            token.span.start,
            token.span.end,
            "예상하지 못한 토큰입니다",
        ));
    }
    Ok(Some(expression))
}

pub(crate) fn compile(expression: &Expr) -> CompiledQuery {
    let mut params = Vec::new();
    let sql = compile_expression(expression, &mut params);
    CompiledQuery { sql, params }
}

struct Parser {
    source_len: usize,
    tokens: Vec<Token>,
    cursor: usize,
}

impl Parser {
    fn parse_or(&mut self) -> Result<Expr, CatalogQueryError> {
        let mut expression = self.parse_and()?;
        while self.consume(|kind| matches!(kind, TokenKind::Or)).is_some() {
            let right = self.parse_and()?;
            expression = Expr::Or(Box::new(expression), Box::new(right));
        }
        Ok(expression)
    }

    fn parse_and(&mut self) -> Result<Expr, CatalogQueryError> {
        let mut expression = self.parse_unary()?;
        loop {
            let explicit = self
                .consume(|kind| matches!(kind, TokenKind::And))
                .is_some();
            let implicit = self.peek().is_some_and(|token| starts_unary(&token.kind));
            if !explicit && !implicit {
                break;
            }
            let right = self.parse_unary()?;
            expression = Expr::And(Box::new(expression), Box::new(right));
        }
        Ok(expression)
    }

    fn parse_unary(&mut self) -> Result<Expr, CatalogQueryError> {
        if self
            .consume(|kind| matches!(kind, TokenKind::Not | TokenKind::Minus))
            .is_some()
        {
            return Ok(Expr::Not(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, CatalogQueryError> {
        let Some(token) = self.advance().cloned() else {
            return Err(error(
                self.source_len,
                self.source_len,
                "검색 조건이 더 필요합니다",
            ));
        };
        match token.kind {
            TokenKind::LeftParen => {
                let expression = self.parse_or()?;
                let Some(closing) = self.advance() else {
                    return Err(error(
                        token.span.start,
                        self.source_len,
                        "괄호가 닫히지 않았습니다",
                    ));
                };
                if !matches!(closing.kind, TokenKind::RightParen) {
                    return Err(error(
                        closing.span.start,
                        closing.span.end,
                        "닫는 괄호가 필요합니다",
                    ));
                }
                Ok(expression)
            }
            TokenKind::Value(value) => Ok(Expr::Title(value)),
            TokenKind::Word(word) => self.parse_word(token.span, word),
            _ => Err(error(
                token.span.start,
                token.span.end,
                "검색 조건이 필요합니다",
            )),
        }
    }

    fn parse_word(&mut self, span: SourceSpan, word: String) -> Result<Expr, CatalogQueryError> {
        if let Some(comparison) = self.consume_comparison() {
            if !word.eq_ignore_ascii_case("pages") {
                return Err(error(
                    span.start,
                    span.end,
                    "페이지 비교에만 숫자 연산자를 사용할 수 있습니다",
                ));
            }
            let (value, value_span) = self.take_value("페이지 수가 필요합니다")?;
            return parse_number(&value, value_span, true)
                .map(|number| Expr::Pages(comparison, number));
        }
        if self
            .consume(|kind| matches!(kind, TokenKind::Colon))
            .is_none()
        {
            return Ok(Expr::Title(word));
        }
        let (value, value_span) = self.take_value("':' 뒤에 값이 필요합니다")?;
        let field = word.to_lowercase();
        match field.as_str() {
            "id" => parse_number(&value, value_span, false).map(Expr::Id),
            "category" => parse_category(&value).map(Expr::Category).ok_or_else(|| {
                error(
                    value_span.start,
                    value_span.end,
                    "알 수 없는 category 값입니다",
                )
            }),
            "uploader" => Ok(Expr::Uploader(value)),
            "pages" => parse_number(&value, value_span, true)
                .map(|number| Expr::Pages(Comparison::Equal, number)),
            _ => Ok(Expr::Tag {
                namespace: field,
                value,
            }),
        }
    }

    fn take_value(&mut self, message: &str) -> Result<(String, SourceSpan), CatalogQueryError> {
        let Some(token) = self.advance().cloned() else {
            return Err(error(self.source_len, self.source_len, message));
        };
        match token.kind {
            TokenKind::Word(value) | TokenKind::Value(value) => Ok((value, token.span)),
            _ => Err(error(token.span.start, token.span.end, message)),
        }
    }

    fn consume_comparison(&mut self) -> Option<Comparison> {
        let comparison = match self.peek()?.kind {
            TokenKind::Greater => Comparison::Greater,
            TokenKind::GreaterEqual => Comparison::GreaterEqual,
            TokenKind::Less => Comparison::Less,
            TokenKind::LessEqual => Comparison::LessEqual,
            _ => return None,
        };
        self.cursor += 1;
        Some(comparison)
    }

    fn consume(&mut self, predicate: impl FnOnce(&TokenKind) -> bool) -> Option<&Token> {
        if self.peek().is_some_and(|token| predicate(&token.kind)) {
            let index = self.cursor;
            self.cursor += 1;
            self.tokens.get(index)
        } else {
            None
        }
    }

    fn advance(&mut self) -> Option<&Token> {
        let index = self.cursor;
        self.cursor += usize::from(index < self.tokens.len());
        self.tokens.get(index)
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.cursor)
    }
}

fn starts_unary(kind: &TokenKind) -> bool {
    matches!(
        kind,
        TokenKind::Word(_)
            | TokenKind::Value(_)
            | TokenKind::LeftParen
            | TokenKind::Minus
            | TokenKind::Not
    )
}

fn parse_number(value: &str, span: SourceSpan, allow_zero: bool) -> Result<i64, CatalogQueryError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|number| *number >= i64::from(!allow_zero))
        .ok_or_else(|| error(span.start, span.end, "유효한 정수가 필요합니다"))
}

fn parse_category(value: &str) -> Option<i64> {
    let normalized = value.to_lowercase();
    if let Ok(category) = normalized.parse::<i64>() {
        return (1..=11).contains(&category).then_some(category);
    }
    let compact = normalized
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '-' | '_'))
        .collect::<String>();
    let category = match compact.as_str() {
        "doujinshi" | "동인지" => 1,
        "manga" | "만화" => 2,
        "artistcg" | "아티스트cg" => 3,
        "gamecg" | "게임cg" => 4,
        "western" | "서양" => 5,
        "imageset" | "이미지세트" => 6,
        "nonh" | "비성인" => 7,
        "cosplay" | "코스프레" => 8,
        "asianporn" | "아시아포르노" => 9,
        "misc" | "기타" => 10,
        "private" | "비공개" => 11,
        _ => return None,
    };
    (1..=11).contains(&category).then_some(category)
}

fn compile_expression(expression: &Expr, params: &mut Vec<Value>) -> String {
    match expression {
        Expr::Title(value) => {
            let pattern = format!("%{}%", escape_like(value));
            params.push(pattern.clone().into());
            params.push(pattern.into());
            "(work.Title LIKE ? ESCAPE '\\' OR COALESCE(work.TitleJpn, '') LIKE ? ESCAPE '\\')"
                .into()
        }
        Expr::Tag { namespace, value } => {
            params.push(namespace.clone().into());
            params.push(value.clone().into());
            "EXISTS (SELECT 1 FROM catalog.Tags AS query_tag WHERE query_tag.WorkId = work.Id AND query_tag.Namespace = ? AND query_tag.Value = ?)".into()
        }
        Expr::Id(value) => {
            params.push((*value).into());
            "work.Id = ?".into()
        }
        Expr::Category(value) => {
            params.push((*value).into());
            "COALESCE(work.Category, -1) = ?".into()
        }
        Expr::Uploader(value) => {
            params.push(value.clone().into());
            "COALESCE(work.Uploader, '') = ? COLLATE NOCASE".into()
        }
        Expr::Pages(comparison, value) => {
            params.push((*value).into());
            format!("work.FileCount {} ?", comparison_sql(*comparison))
        }
        Expr::Not(expression) => format!("NOT ({})", compile_expression(expression, params)),
        Expr::And(left, right) => format!(
            "({} AND {})",
            compile_expression(left, params),
            compile_expression(right, params)
        ),
        Expr::Or(left, right) => format!(
            "({} OR {})",
            compile_expression(left, params),
            compile_expression(right, params)
        ),
    }
}

fn comparison_sql(comparison: Comparison) -> &'static str {
    match comparison {
        Comparison::Equal => "=",
        Comparison::Greater => ">",
        Comparison::GreaterEqual => ">=",
        Comparison::Less => "<",
        Comparison::LessEqual => "<=",
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn error(start: usize, end: usize, message: impl Into<String>) -> CatalogQueryError {
    CatalogQueryError {
        span: SourceSpan { start, end },
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_words_quotes_escapes_operators_and_source_spans() {
        let tokens = tokenize(r#"alpha "two \"words\"" AND -(pages>=12 OR artist:foo)"#).unwrap();
        assert_eq!(tokens[0], token(TokenKind::Word("alpha".into()), 0, 5));
        assert_eq!(
            tokens[1],
            token(TokenKind::Value("two \"words\"".into()), 6, 21)
        );
        assert!(tokens.iter().any(|item| item.kind == TokenKind::And));
        assert!(tokens.iter().any(|item| item.kind == TokenKind::Minus));
        assert!(tokens
            .iter()
            .any(|item| item.kind == TokenKind::GreaterEqual));
        assert!(tokens.iter().any(|item| item.kind == TokenKind::LeftParen));
        assert!(tokens.iter().any(|item| item.kind == TokenKind::RightParen));
    }

    #[test]
    fn tokenizer_rejects_invalid_and_unclosed_quotes_at_their_source_position() {
        let error = tokenize("title \"unfinished").unwrap_err();
        assert_eq!(error.span, SourceSpan { start: 6, end: 17 });

        let error = tokenize(r#""bad \q""#).unwrap_err();
        assert_eq!(error.span, SourceSpan { start: 5, end: 7 });
    }

    #[test]
    fn parser_honors_boolean_precedence_implicit_and_and_nested_negation() {
        let expression = parse("alpha OR beta gamma AND NOT -(artist:foo OR pages<10)")
            .unwrap()
            .unwrap();
        assert_eq!(
            expression,
            Expr::Or(
                Box::new(title("alpha")),
                Box::new(Expr::And(
                    Box::new(Expr::And(Box::new(title("beta")), Box::new(title("gamma")))),
                    Box::new(Expr::Not(Box::new(Expr::Not(Box::new(Expr::Or(
                        Box::new(tag("artist", "foo")),
                        Box::new(Expr::Pages(Comparison::Less, 10)),
                    )))))),
                )),
            )
        );
    }

    #[test]
    fn parser_builds_typed_id_category_uploader_and_page_predicates() {
        assert_eq!(parse("id:42").unwrap(), Some(Expr::Id(42)));
        assert_eq!(parse("category:manga").unwrap(), Some(Expr::Category(2)));
        assert_eq!(parse("category:동인지").unwrap(), Some(Expr::Category(1)));
        assert_eq!(
            parse("category:\"artist CG\"").unwrap(),
            Some(Expr::Category(3))
        );
        assert_eq!(parse("category:non-h").unwrap(), Some(Expr::Category(7)));
        assert_eq!(
            parse("uploader:\"some user\"").unwrap(),
            Some(Expr::Uploader("some user".into()))
        );
        assert_eq!(
            parse("pages:20").unwrap(),
            Some(Expr::Pages(Comparison::Equal, 20))
        );
        assert_eq!(
            parse("pages>20").unwrap(),
            Some(Expr::Pages(Comparison::Greater, 20))
        );
        assert_eq!(
            parse("pages>=20").unwrap(),
            Some(Expr::Pages(Comparison::GreaterEqual, 20))
        );
        assert_eq!(
            parse("pages<20").unwrap(),
            Some(Expr::Pages(Comparison::Less, 20))
        );
        assert_eq!(
            parse("pages<=20").unwrap(),
            Some(Expr::Pages(Comparison::LessEqual, 20))
        );
    }

    #[test]
    fn parser_preserves_simple_and_quoted_title_and_namespace_compatibility() {
        assert_eq!(parse("").unwrap(), None);
        assert_eq!(parse("제독").unwrap(), Some(title("제독")));
        assert_eq!(parse("well-known").unwrap(), Some(title("well-known")));
        assert_eq!(
            parse("\"old admiral\"").unwrap(),
            Some(title("old admiral"))
        );
        assert_eq!(
            parse("character:teitoku").unwrap(),
            Some(tag("character", "teitoku"))
        );
    }

    #[test]
    fn parser_rejects_malformed_expressions_with_useful_spans() {
        for query in [
            "alpha AND",
            "(alpha OR beta",
            "pages>=nope",
            "category:unknown",
            "artist:",
            "OR alpha",
        ] {
            let error = parse(query).unwrap_err();
            assert!(error.span.start <= query.len(), "{query}: {error:?}");
            assert!(!error.message.is_empty(), "{query}");
        }
    }

    #[test]
    fn parser_rejects_unbounded_query_input() {
        let too_long = "a".repeat(MAX_QUERY_BYTES + 1);
        assert!(parse(&too_long).is_err());
        let too_many = std::iter::repeat_n("a", MAX_QUERY_TOKENS + 1)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(parse(&too_many).is_err());
    }

    #[test]
    fn compiler_binds_values_escapes_like_wildcards_and_groups_boolean_sql() {
        let expression = parse(r#"(100%_safe OR uploader:"x' OR 1=1 --") AND -artist:foo"#)
            .unwrap()
            .unwrap();
        let compiled = compile(&expression);
        assert!(!compiled.sql.contains("100%_safe"));
        assert!(!compiled.sql.contains("x' OR 1=1"));
        assert!(compiled.sql.contains("NOT"));
        assert!(compiled.sql.contains("EXISTS"));
        assert_eq!(
            compiled.params[0],
            rusqlite::types::Value::Text("%100\\%\\_safe%".into())
        );
        assert!(compiled
            .params
            .iter()
            .any(|value| value == &rusqlite::types::Value::Text("x' OR 1=1 --".into())));
        assert!(compiled
            .params
            .iter()
            .any(|value| value == &rusqlite::types::Value::Text("artist".into())));
    }

    #[test]
    fn compiler_uses_typed_numeric_parameters() {
        let compiled = compile(
            &parse("id:42 AND category:2 AND pages>=10")
                .unwrap()
                .unwrap(),
        );
        assert_eq!(
            compiled.params,
            vec![
                rusqlite::types::Value::Integer(42),
                rusqlite::types::Value::Integer(2),
                rusqlite::types::Value::Integer(10),
            ]
        );
    }

    fn token(kind: TokenKind, start: usize, end: usize) -> Token {
        Token {
            kind,
            span: SourceSpan { start, end },
        }
    }

    fn title(value: &str) -> Expr {
        Expr::Title(value.into())
    }

    fn tag(namespace: &str, value: &str) -> Expr {
        Expr::Tag {
            namespace: namespace.into(),
            value: value.into(),
        }
    }
}
