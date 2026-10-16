import json


def test_dry_import_roles_and_missing_answers(client):
    response = client.post(
        "/api/imports/quick?dry_run=true",
        files={
            "files[]": (
                "questions.txt",
                "1. Производная функции\n2. Матрицы и определители\n3. Пределы функции".encode(),
            )
        },
        data={"options": json.dumps({"roles": {"questions.txt": "questions"}})},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert len(result["questions"]) == 3
    assert result["questions"][0]["answer_text"] is None
    assert result["documents"][0]["role"] == "questions"


def test_import_unsupported_and_empty(client):
    assert client.post("/api/imports/quick?dry_run=true").json()["code"] == "import_empty"
    response = client.post("/api/imports/quick?dry_run=true", files={"files[]": ("test.doc", b"a")})
    assert response.status_code == 415
    assert "DOCX" in response.json()["detail"]
    assert client.post("/api/imports/quick", data={"text": "a", "options": "{"}).status_code == 422
