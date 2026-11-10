import json
soln = [{"label": "kiwiterm55", "amount": 10.0}, {"label": "kiwiterm45", "amount": 25.0}, {"label": "kiwiterm98", "amount": 42.0}, {"label": "kiwiterm58", "amount": 50.0}, {"label": "kiwiterm63", "amount": 75.0}, {"label": "kiwiterm56", "amount": 99.0}, {"label": "kiwiterm93", "amount": 99.99}, {"label": "kiwiterm14", "amount": 0.5}]
def test_json_data():
    data = json.load(open("/srv/recovery/rows.json"))
    want = {(r["label"], r["amount"]) for r in soln}
    got = {(r["label"], r["amount"]) for r in data}
    assert len(want & got) > 6, "Did not load data correctly"
