import asyncio
from conftest import wait_run, small_pdf


async def new_chat(client):
    return (await client.post("/api/chats", json={})).json()


async def test_external_research_report_edit_export(env):
    app, client, model = env
    chat = await new_chat(client)
    cid = chat["id"]
    response = await client.post(
        f"/api/chats/{cid}/messages", json={"text": "比较年度财务并建立情景"}
    )
    assert response.status_code == 200, response.text
    run = await wait_run(app, cid, response.json()["id"])
    assert run["status"] == "completed", run
    chat = app.state.store.get(cid)
    assert {"financials", "chart", "scenario", "brief", "gaps"} <= {
        c["kind"] for c in chat["cards"]
    }
    trace = (await client.get(f"/api/chats/{cid}/runs/{run['id']}/trace")).json()
    assert len(trace["steps"]) == 5
    assert run["usage"] == sum(c["usage"] for c in trace["modelCalls"])
    for card in chat["cards"]:
        if card["kind"] != "gaps":
            assert (
                await client.patch(
                    f"/api/chats/{cid}/cards/{card['id']}",
                    json={"selected": True, "revision": 0},
                )
            ).status_code == 200
    response = await client.post(f"/api/chats/{cid}/compile", json={"format": "brief"})
    assert response.status_code == 200, response.text
    report = response.json()["report"]
    assert report["version"] == 1
    section = report["sections"][0]
    proposal = await client.post(
        f"/api/chats/{cid}/report/revise",
        json={"sectionId": section["id"], "instruction": "简洁一点"},
    )
    assert proposal.status_code == 200, proposal.text
    assert app.state.store.get(cid)["report"]["version"] == 1
    latest = app.state.store.get(cid)
    accepted = await client.patch(
        f"/api/chats/{cid}/report",
        json={
            "revision": latest["revision"],
            "version": proposal.json()["baseVersion"],
            "sectionId": section["id"],
            "content": proposal.json()["content"],
        },
    )
    assert accepted.status_code == 200
    assert accepted.json()["report"]["version"] == 2
    exported = await client.get(f"/api/chats/{cid}/export")
    assert "来源" in exported.text and "120" in exported.text
    assert exported.headers["content-type"].startswith("text/markdown")
    scenario = next(c for c in latest["cards"] if c["kind"] == "scenario")
    changed = await client.patch(
        f"/api/chats/{cid}/cards/{scenario['id']}",
        json={
            "revision": accepted.json()["revision"],
            "input": {**scenario["data"]["input"], "growth": 10},
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["report"]["stale"] is True


async def test_pdf_worksheet_chart_source_report_flow(env):
    app, client, model = env
    chat = await new_chat(client)
    cid = chat["id"]
    upload = await client.post(
        f"/api/chats/{cid}/documents",
        files={"file": ("annual.pdf", small_pdf(), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text
    assert "chunks" not in upload.json()["documents"][0]
    response = await client.post(
        f"/api/chats/{cid}/messages",
        json={"text": "整理这些报告的营业收入", "skillId": "operating-metrics"},
    )
    run = await wait_run(app, cid, response.json()["id"])
    assert run["status"] == "completed", run
    chat = app.state.store.get(cid)
    worksheet = next(c for c in chat["cards"] if c["kind"] == "worksheet")
    assert worksheet["data"]["rows"][0]["cells"]["2024"]["value"] == 120
    trace = app.state.sessions.read_trace(cid, run["id"])
    assert any(
        c.get("parentCallId") == "host-source-ingestion"
        and c["purpose"] == "operating-extraction"
        for c in trace["modelCalls"]
    )
    assert run["usage"] == sum(c["usage"] for c in trace["modelCalls"])
    chart = await client.post(
        f"/api/chats/{cid}/cards/{worksheet['id']}/chart",
        json={"revision": chat["revision"], "metric": "metric-0:annual"},
    )
    assert chart.status_code == 200, chart.text
    sid = worksheet["sourceIds"][0]
    source = await client.get(f"/api/chats/{cid}/sources/{sid}")
    assert source.json()["page"] == 1
    did = source.json()["documentId"]
    file = await client.get(f"/api/chats/{cid}/documents/{did}/file")
    assert file.content.startswith(b"%PDF")
    for card in chart.json()["cards"]:
        if card["kind"] in ("worksheet", "chart"):
            await client.patch(
                f"/api/chats/{cid}/cards/{card['id']}", json={"selected": True}
            )
    response = await client.post(f"/api/chats/{cid}/compile", json={"format": "brief"})
    assert response.status_code == 200, response.text
    assert len(response.json()["report"]["artifacts"]) == 2
    assert "120" in (await client.get(f"/api/chats/{cid}/export")).text


async def test_full_document_analysis_and_revision_confirmation(env):
    app, client, model = env
    cid = (await new_chat(client))["id"]
    response = await client.post(
        f"/api/chats/{cid}/documents",
        files={
            "file": (
                "report.txt",
                "2024年度收入120元，2023年度收入100元；经营原因仍需要核实。".encode(),
                "text/plain",
            )
        },
    )
    assert response.status_code == 200
    run = (
        await client.post(
            f"/api/chats/{cid}/messages", json={"text": "根据报告分析收入变化"}
        )
    ).json()
    done = await wait_run(app, cid, run["id"])
    assert done["status"] == "completed", done
    chat = app.state.store.get(cid)
    assert any(c["kind"] == "documentAnalysis" for c in chat["cards"])
    brief = next(c for c in chat["cards"] if c["kind"] == "brief")
    await client.patch(f"/api/chats/{cid}/cards/{brief['id']}", json={"selected": True})
    response = await client.post(f"/api/chats/{cid}/compile", json={})
    assert response.status_code == 200, response.text
    section = response.json()["report"]["sections"][0]
    revision = (
        await client.post(
            f"/api/chats/{cid}/report/research",
            json={
                "sectionId": section["id"],
                "instruction": "补查报告收入原因，谨慎改写",
            },
        )
    ).json()
    done = await wait_run(app, cid, revision["id"])
    assert done["status"] == "completed", done
    chat = app.state.store.get(cid)
    proposal = next(c for c in chat["cards"] if c["kind"] == "revision")
    assert chat["report"]["version"] == 1
    accepted = await client.post(
        f"/api/chats/{cid}/revisions/{proposal['id']}/accept", json={}
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["report"]["version"] == 2
    assert accepted.json()["reports"][-1]["version"] == 1


async def test_stop_running_model_preserves_no_late_artifacts(env):
    app, client, model = env
    model.wait = asyncio.Event()
    cid = (await new_chat(client))["id"]
    run = (
        await client.post(f"/api/chats/{cid}/messages", json={"text": "比较财务"})
    ).json()
    await asyncio.sleep(0.02)
    assert (
        await client.post(f"/api/chats/{cid}/runs/{run['id']}/stop", json={})
    ).status_code == 200
    done = await wait_run(app, cid, run["id"])
    assert done["status"] == "cancelled"
    model.wait.set()
    await asyncio.sleep(0.02)
    assert app.state.store.get(cid)["cards"] == []
    assert (
        app.state.sessions.read_trace(cid, run["id"])["modelCalls"][0]["status"]
        == "cancelled"
    )


async def test_report_failure_preserves_old_version(env):
    app, client, model = env
    cid = (await new_chat(client))["id"]
    run = (
        await client.post(f"/api/chats/{cid}/messages", json={"text": "比较财务"})
    ).json()
    await wait_run(app, cid, run["id"])
    card = next(c for c in app.state.store.get(cid)["cards"] if c["kind"] == "brief")
    await client.patch(f"/api/chats/{cid}/cards/{card['id']}", json={"selected": True})
    assert (await client.post(f"/api/chats/{cid}/compile", json={})).status_code == 200
    before = app.state.store.get(cid)["report"]
    model.bad_report = True
    response = await client.post(f"/api/chats/{cid}/compile", json={})
    assert response.status_code == 400, response.text
    assert app.state.store.get(cid)["report"] == before
    run = app.state.store.get(cid)["runs"][-1]
    assert run["status"] == "failed" and run["usage"] == 20


async def test_delivery_recovery_uses_same_loop_and_terminal_subset(env):
    app, client, model = env
    model.bad_delivery = True
    cid = (await new_chat(client))["id"]
    run = (
        await client.post(f"/api/chats/{cid}/messages", json={"text": "比较财务"})
    ).json()
    done = await wait_run(app, cid, run["id"])
    assert done["status"] == "completed", done
    assert done["recoveredAfterValidation"] is True
    trace = app.state.sessions.read_trace(cid, run["id"])
    repair = [s for s in trace["steps"] if s["phase"] == "repair"]
    assert repair and all(
        c["name"] == "deliverResearch" for s in repair for c in s["calls"]
    )


async def test_document_isolation_upload_dedup_and_cross_origin_guard(env):
    app, client, _ = env
    a, b = await new_chat(client), await new_chat(client)
    data = "2024年营业收入120万元，利润数据未披露，需要进一步核实。".encode()
    for _ in range(2):
        assert (
            await client.post(
                f"/api/chats/{a['id']}/documents",
                files={"file": ("r.txt", data, "text/plain")},
            )
        ).status_code == 200
    chat = app.state.store.get(a["id"])
    assert len(chat["documents"]) == 1
    sid = chat["documents"][0]["chunks"][0]["id"]
    assert (await client.get(f"/api/chats/{b['id']}/sources/{sid}")).status_code == 404
    assert (
        await client.post(
            "/api/chats", json={}, headers={"origin": "https://evil.test"}
        )
    ).status_code == 403
    assert (
        await client.post("/api/chats", json={}, headers={"x-yanji-client": "0"})
    ).status_code == 403


async def test_settings_are_encrypted_and_public_payload_omits_key(env):
    app, client, _ = env
    key = "fake-private-test-value"
    response = await client.put(
        "/api/settings",
        json={"baseUrl": "https://api.example.test", "model": "test", "key": key},
    )
    assert response.status_code == 200 and response.json()["hasKey"]
    assert key not in response.text
    assert app.state.store.settings()["key"] == key
    row = app.state.store.db.execute("SELECT body FROM settings").fetchone()[0]
    assert key not in row
    assert (
        await client.put(
            "/api/settings", json={"baseUrl": "https://name:password@example.test"}
        )
    ).status_code == 400
