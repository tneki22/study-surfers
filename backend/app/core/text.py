import re
import unicodedata


def norm_quote(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\u00ad", "").casefold().replace("ё", "е")
    text = re.sub('[«»“”„"]', '"', text)
    text = re.sub("[‐‑‒–—−]", "-", text)
    return " ".join(text.split())


def norm_option(text: str) -> str:
    parts = re.split(r"(\$[^$]+\$)", norm_quote(text))
    return "".join(
        re.sub(r"[\s{}$]+", "", part)
        if part.startswith("$")
        else re.sub(r"[^\d+\-.,/%]+", "", part)
        if re.fullmatch(r"[\s+\-\d.,/%]+", part)
        else re.sub(r"[\W_]+", "", part)
        for part in parts
    )


def visible_len(text: str) -> int:
    text = re.sub(r"\\[a-zA-Z]+", "", text)
    return len(re.sub(r"[$\{\}]", "", text).strip())


def slug(text: str) -> str:
    return re.sub(r"[^\w-]+", "-", text.casefold()).strip("-_")[:80] or "deck"
