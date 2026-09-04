import asyncio

from api import server


def test_get_analytics_returns_expected_shape():
    result = asyncio.run(server.get_analytics("test-admin"))

    assert isinstance(result, dict)
    assert "peakHours" in result
    assert "popularSeats" in result
    assert "facilityUsage" in result
    assert "unmetDemand" in result
    assert "turnover" in result
    assert "dailyCheckins" in result
    assert "zoneStats" in result
    assert "floorStats" in result
    assert "totalCheckins" in result
    assert "totalCheckouts" in result
    assert "uniqueSeatsUsed" in result
