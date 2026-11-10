import re
from pathlib import Path

def test_regex_matches_dates():
    regex_file = Path("/srv/logscan/date_rule.re")
    assert regex_file.exists(), f"{regex_file} missing"
    pattern_text = regex_file.read_text().strip()
    re.compile(pattern_text)
    sample_logs = [
        "Edge case 0.0.0.0 and date 03/03/2017",
        "Routine check by 203.0.113.10 ended on 05/03/1999",
        "11/11/2024 login from 198.51.100.23 at start",
        "User login 192.168.1.1abc on 01/12/2021",
        "192.168.1.100 accessed on 31/12/2023 and 01/11/2024",
        "Multiple IPs 10.0.0.1 10.0.0.2 with 01/01/2020",
        "Connection from 192.168.0.10 on 05/13/2023",
        "Another invalid 123.456.78.90 12/12/2020",
        "Client 8.8.8.8 reported on 00/09/2001",
        "Server 172.16.5.4 logged event on 32/06/1995",
        "Backup abc20/08/2021 from 203.0.113.5 completed",
        "Login attempt 172.16.0.256 for user 31/04/2000",
        "Invalid IP 256.100.50.25 with date 01/01/2021",
        "Broadcast 255.255.255.255 on 31/12/2016",
        "Login attempt 172.16.0.256 for user 30/02/2000",
        "Error for user with code abc192.168.1.1 on 01/01/2023",
        "09/01/2025 User login from 192.168.0.1",
        "No IP here but 05/05/2022 appears",
        "Login attempt 172.16.0.256 on 10/05/2000",
        "IP with date before and after 05/05/2018 8.8.8.8 info 06/06/2018",
        "User 192.0.2.1 performed action 15/07/2020abc",
        "Broadcast 255.255.255.255 for user 1234-56-7890",
        "Access from 10.0.0.5 at 15/00/2022",
        "Date before IP 15/06/2019 from 172.16.0.5",
        "abc10.0.0.5 accessed system on 20/07/1999"
]
    expected_dates = ["03/03/2017", "05/03/1999", "11/11/2024", "01/11/2024", "01/01/2020", "31/12/2016", "09/01/2025", "06/06/2018", "15/06/2019"]
    matches = re.findall(pattern_text, "\n".join(sample_logs), re.MULTILINE)
    assert matches == expected_dates, f"Expected {expected_dates}, but got {matches}"
