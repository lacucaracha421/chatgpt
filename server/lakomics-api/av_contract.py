"""AV limits shared by authority commands and the public read models."""

TEXT_LIMITS = {"productCode": 64, "titleJa": 2000, "maker": 500,
               "label": 500, "series": 500}
MAX_GENRES = 64
MAX_GENRE_LENGTH = 100
MAX_CREDITS = 64
MAX_PERSON_NAME = 500
MAX_CREDIT_NAME = 500
MAX_PERSON_MEMO = 2000
MAX_PORTRAIT_BYTES = 5 * 1024 * 1024
MAX_PORTRAIT_DIMENSION = 1600
DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
